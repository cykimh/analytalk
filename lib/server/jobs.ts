// 리포트 한 편을 실행하고 저장한다(runReportJob). 서버 전용. 생성·다시 쓰기 라우트가 after()에서 같은 함수 호출 안에서 부른다.
// v2.5: 리포트 한 편을 호출 3~4개로 나눠 쓴다(lib/llm/split.ts). 모두 이 함수 호출 안의 Promise로 돌고, 결과는 합쳐서 한 행에 저장한다.
// 페이로드는 메모리로만 넘긴다. DB·로그에 남기지 않는다.
import "server-only";
import { CYCLE_ANCHOR_DAY } from "@/lib/config";
import { buildRequests } from "@/lib/llm/prompt";
import { type CallResult, mergeReportCalls, runReportCalls, spentOf } from "@/lib/llm/split";
import type { Payload } from "@/lib/payload/build";
import type { AppRepo } from "./repo";
import type { HandlerDeps } from "./route";

/** 응답 시작 전 일시 오류를 같은 함수에서 다시 해 볼 수 있는 시간(실행 시작부터) */
const RETRY_WINDOW_MS = 60_000;
const SEOUL_OFFSET_MS = 9 * 3_600_000;

// ===== 정지 시각 =====

/** 지출 한도는 매월 1일 00:00 UTC에 풀린다 */
const nextMonthUtc = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

/**
 * now 다음에 오는 크레딧 주기 시작 = 기준일(anchorDay) 00:00 서울. SQL analytalk.cycle_start와 같은 주기다.
 * 기준일은 1~28이라 어느 달에나 그날이 있다
 */
export function nextCycleStart(now: Date, anchorDay: number): Date {
  const seoul = new Date(now.getTime() + SEOUL_OFFSET_MS);
  const month = seoul.getUTCMonth() + (seoul.getUTCDate() >= anchorDay ? 1 : 0);
  return new Date(Date.UTC(seoul.getUTCFullYear(), month, anchorDay) - SEOUL_OFFSET_MS);
}

/** 한도 오류가 풀리는 시각 = setPaused에 거는 값. 지출 한도는 다음 달 1일 00:00 UTC, 크레딧 소진은 다음 주기 시작 */
export function limitLiftsAt(kind: "spend_limit" | "credit_exhausted", now: Date): Date {
  return kind === "spend_limit" ? nextMonthUtc(now) : nextCycleStart(now, CYCLE_ANCHOR_DAY);
}

// ===== 리포트 실행 =====

type Finish = Parameters<AppRepo["finishReport"]>[0];

const failure = (id: string, errorCode: string): Finish => ({
  id,
  status: "failed",
  content: null,
  model: null,
  stopReason: null,
  errorCode,
  usage: null,
  cost: 0,
});

/**
 * 리포트를 만들어 저장한다. 전제: 리포트는 이미 running이다(startReport·retryReport가 시작했다).
 * ①을 먼저 시작하고 ①의 message_start에서 나머지 호출을 동시에 시작한다. 응답 전 일시 오류는 60초 안이면 그 호출만 1번 다시 한다.
 * 어느 호출이 실패하면 나머지로 partial을 저장한다. 한도 오류(spend_limit·credit_exhausted)면 정지 시각을 건다.
 * 결과는 finishReport 한 번으로 남긴다(usage는 호출마다 더한 한 행 = 유료 실행 한 번. 다시 쓰기 횟수 규칙이 이 행 수를 센다).
 * deps.fetch(자기 호출)를 쓰지 않는다. 던지지 않는다: 예상 못 한 오류는 failed(internal)로 남긴다
 */
export async function runReportJob(deps: HandlerDeps, a: { id: string; payload: Payload }): Promise<void> {
  const { repo, client } = deps;
  // 호출이 다 돈 뒤 합치기·저장이 던져도 쓴 돈은 원장에 남긴다(리뷰 minor 4)
  let results: CallResult[] | null = null;
  try {
    if (!client) {
      await repo.finishReport(failure(a.id, "not_ready"));
      return;
    }
    const calls = buildRequests(a.payload);
    const deadlineAt = deps.deadlineAt();
    results = await runReportCalls(client, calls, {
      deadlineAt,
      now: deps.now,
      retryWindowMs: RETRY_WINDOW_MS,
      onNotes: (notes) => repo.saveProgress(a.id, notes),
      onStreamStart: (part, model, requested, cacheRead) => {
        if (model !== requested) console.warn(`[jobs] fallback_on_writer(${part}): ${requested} → ${model}`);
        // ① 뒤 호출이 캐시를 못 읽으면(타이밍, ①이 다른 모델로 응답) 한 편이 약 $3.5 더 든다. 몫 이름만 남긴다(리뷰 minor 1)
        if (part !== calls[0].part && cacheRead === 0) console.warn(`[jobs] cache_miss(${part})`);
      },
    });
    const merged = mergeReportCalls(a.payload, results);
    if (merged.limit) await repo.setPaused(limitLiftsAt(merged.limit, new Date(deps.now())));
    await repo.finishReport({
      id: a.id,
      status: merged.status,
      content: merged.content,
      errorCode: merged.errorCode,
      model: merged.model,
      stopReason: merged.stopReason,
      usage: merged.usage,
      cost: merged.cost,
    });
  } catch (e) {
    // 오류 문구에 출력 글이 섞일 수 있는 곳(JSON.parse)은 split에서 따로 잡는다. 여기는 DB 오류처럼 문구가 안전한 것들이다
    console.error(`[jobs] 리포트 실행 실패: ${e instanceof Error ? e.message : "unknown"}`);
    const spent = results ? spentOf(results) : null;
    await repo.finishReport({ ...failure(a.id, "internal"), ...(spent ?? {}) }).catch(() => {});
  }
}
