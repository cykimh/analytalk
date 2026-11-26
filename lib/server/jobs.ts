// 리포트 한 편을 실행하고 저장한다(runReportJob). 서버 전용. 생성·다시 쓰기 라우트가 after()에서 같은 함수 호출 안에서 부른다.
// 페이로드는 메모리로만 넘긴다. DB·로그에 남기지 않는다.
import "server-only";
import { CYCLE_ANCHOR_DAY } from "@/lib/config";
import { estimateCostUsd } from "@/lib/llm/cost";
import { salvageReport } from "@/lib/llm/notes";
import { buildRequest } from "@/lib/llm/prompt";
import { type RunResult, runReport } from "@/lib/llm/stream";
import { validateReport } from "@/lib/llm/validate";
import { type Payload, payloadIndex } from "@/lib/payload/build";
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

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** 결과 → 저장할 상태·내용·오류 코드. 한도 오류면 먼저 정지 시각을 건다 */
async function judge(
  deps: HandlerDeps,
  payload: Payload,
  r: RunResult,
): Promise<{ status: string; content: unknown; errorCode: string | null }> {
  const validate = (raw: unknown, truncated: boolean) =>
    validateReport(raw, payloadIndex(payload), payload.stats, { truncated, concept: payload.concept, members: payload.members });
  /** 끊긴 글에서 완결된 섹션만 살린다. done이어도 partial이다 */
  const salvage = (raw: string, failedCode: string) => {
    const v = validate(salvageReport(raw), true);
    if (v.status === "failed") return { status: "failed", content: null, errorCode: failedCode };
    return { status: v.status === "done" ? "partial" : v.status, content: v.content, errorCode: null };
  };

  switch (r.kind) {
    case "ok": {
      const v = validate(parseJson(r.raw), false);
      return { status: v.status, content: v.content, errorCode: v.status === "failed" ? "invalid_output" : null };
    }
    case "truncated":
      return salvage(r.raw, "max_tokens");
    case "partial":
      return salvage(r.raw, "timeout");
    case "refused":
      // 거절 분류만 남긴다(문구 없는 열거값이라 출력 글·이름이 섞이지 않는다)
      return { status: "refused", content: null, errorCode: r.stopCategory ? `refusal_${r.stopCategory}` : null };
    case "error": {
      let errorCode: string = r.error ?? "fatal";
      if (r.error === "spend_limit" || r.error === "credit_exhausted") {
        await deps.repo.setPaused(limitLiftsAt(r.error, new Date(deps.now())));
        errorCode = "limit";
      }
      // 응답이 시작된 뒤 끊겼으면 받은 데까지 살린다(R8)
      if (r.startedStream && r.raw !== "") return salvage(r.raw, errorCode);
      return { status: "failed", content: null, errorCode };
    }
  }
}

/**
 * 리포트를 만들어 저장한다. 전제: 리포트는 이미 running이다(startReport·retryReport가 시작했다).
 * 응답 전 일시 오류는 60초 안이면 1번만 다시 한다. 결과는 finishReport 한 번으로 남긴다(usage 한 행 = 유료 실행 한 번).
 * deps.fetch(자기 호출)를 쓰지 않는다. 던지지 않는다: 예상 못 한 오류는 failed(internal)로 남긴다
 */
export async function runReportJob(deps: HandlerDeps, a: { id: string; payload: Payload }): Promise<void> {
  const { repo, client } = deps;
  try {
    if (!client) {
      await repo.finishReport(failure(a.id, "not_ready"));
      return;
    }
    const req = buildRequest(a.payload);
    const startedAt = deps.now();
    const deadlineAt = deps.deadlineAt();

    const onStreamStart = (model: string) => {
      if (model !== req.model) console.warn(`[jobs] fallback_on_writer: ${req.model} → ${model}`);
    };
    const attempt = () => runReport(client, req, { deadlineAt, onStreamStart, onNotes: (notes) => repo.saveProgress(a.id, notes) });

    let r = await attempt();
    if (r.kind === "error" && r.error === "retryable" && !r.startedStream && deps.now() - startedAt <= RETRY_WINDOW_MS) {
      r = await attempt();
    }

    const verdict = await judge(deps, a.payload, r);
    await repo.finishReport({
      id: a.id,
      ...verdict,
      model: r.startedStream ? r.model : null,
      stopReason: r.stopReason,
      usage: r.usage,
      cost: r.usage ? estimateCostUsd(r.usage, r.model) : 0,
    });
  } catch (e) {
    // 오류 문구에 출력 글이 섞일 수 있는 곳(JSON.parse)은 위에서 따로 잡는다. 여기는 DB 오류처럼 문구가 안전한 것들이다
    console.error(`[jobs] 리포트 실행 실패: ${e instanceof Error ? e.message : "unknown"}`);
    await repo.finishReport(failure(a.id, "internal")).catch(() => {});
  }
}
