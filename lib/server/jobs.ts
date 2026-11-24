// 편 하나를 실행하고(runEpisodeJob) 1편 응답이 시작되면 2~4편을 내부 라우트로 띄운다(dispatchRest). 서버 전용.
// 1편의 message_start는 캐시가 읽힐 수 있게 된 시점이라, 그때 띄운 2~4편은 같은 입력을 캐시에서 읽는다.
// 내부 호출은 HMAC(타임스탬프 60초)으로 서명하고, 페이로드는 메모리로만 넘긴다. DB·로그에 남기지 않는다.
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { CYCLE_ANCHOR_DAY } from "@/lib/config";
import { estimateCostUsd } from "@/lib/llm/cost";
import { salvageEpisode } from "@/lib/llm/notes";
import { buildRequest } from "@/lib/llm/prompt";
import { type RunResult, runEpisode } from "@/lib/llm/stream";
import { validateEpisode } from "@/lib/llm/validate";
import { type Payload, payloadIndex } from "@/lib/payload/build";
import { sha256Hex } from "@/lib/payload/hash";
import { resolveBaseUrl } from "./baseUrl";
import type { AppRepo, ConversationRow } from "./repo";
import type { HandlerDeps } from "./route";

export const INTERNAL_EPISODES_PATH = "/api/internal/episodes";
export const INTERNAL_SIGNATURE_HEADER = "x-analytalk-signature";
const SIGNATURE_WINDOW_MS = 60_000;
const DISPATCH_TIMEOUT_MS = 10_000;
/** 응답 시작 전 일시 오류를 같은 함수에서 다시 해 볼 수 있는 시간(편 시작부터) */
const RETRY_WINDOW_MS = 60_000;
const SEOUL_OFFSET_MS = 9 * 3_600_000;

export interface JobDeps extends HandlerDeps {
  baseUrl: string;
  baseHeaders: Record<string, string>;
}

type InternalBody = { id: string; n: number; payloadSha256: string };
type EpisodeN = 1 | 2 | 3 | 4;

/** 요청이 들어온 origin으로 내부 호출을 보내는 deps */
export function jobDeps(deps: HandlerDeps, reqUrl: string): JobDeps {
  const { baseUrl, headers } = resolveBaseUrl(reqUrl);
  return { ...deps, baseUrl, baseHeaders: headers };
}

// ===== 내부 호출 서명 =====

const mac = (body: InternalBody, ts: number, secret: string) =>
  createHmac("sha256", secret).update(JSON.stringify([ts, body.id, body.n, body.payloadSha256])).digest("base64url");

/** 헤더 값 `<ts ms>.<HMAC base64url>`. secret이 비면 던진다 */
export function signInternal(body: InternalBody, ts: number, secret: string): string {
  if (!secret) throw new Error("[jobs] 내부 서명 비밀값이 없다");
  return `${ts}.${mac(body, ts, secret)}`;
}

/** 서명이 맞고 ts가 now ± 60초 안이면 true. 비교는 timingSafeEqual */
export function verifyInternal(header: string | null, body: InternalBody, now: number, secret: string): boolean {
  const m = header ? /^(\d{1,15})\.([\w-]{1,64})$/.exec(header) : null;
  if (!m || !secret) return false;
  const ts = Number(m[1]);
  if (Math.abs(now - ts) > SIGNATURE_WINDOW_MS) return false;
  const given = Buffer.from(m[2]);
  const expected = Buffer.from(mac(body, ts, secret));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

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

// ===== 2~4편 띄우기 =====

/** 편마다 서명한 내부 호출을 보낸다. 202가 아니거나 fetch가 거부되면(10초 timeout 포함) 그 편은 failed(dispatch) */
export async function dispatchRest(deps: JobDeps, a: { id: string; payload: Payload; ns: (2 | 3 | 4)[] }): Promise<void> {
  if (a.ns.length === 0) return;
  const payloadSha256 = await sha256Hex(JSON.stringify(a.payload));
  await Promise.all(
    a.ns.map(async (n) => {
      let accepted = false;
      try {
        const res = await deps.fetch(`${deps.baseUrl}${INTERNAL_EPISODES_PATH}`, {
          method: "POST",
          headers: {
            ...deps.baseHeaders,
            "content-type": "application/json",
            [INTERNAL_SIGNATURE_HEADER]: signInternal({ id: a.id, n, payloadSha256 }, deps.now(), deps.secrets.internal),
          },
          body: JSON.stringify({ id: a.id, n, payload: a.payload }),
          signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
        });
        accepted = res.status === 202;
        await res.body?.cancel();
      } catch {
        // 연결 실패·timeout·서명 비밀값 없음
      }
      if (!accepted) await deps.repo.finishEpisode(failure(a.id, n, "dispatch"));
    }),
  );
}

// ===== 편 실행 =====

type Finish = Parameters<AppRepo["finishEpisode"]>[0];

const failure = (id: string, n: number, errorCode: string): Finish => ({
  id,
  n,
  status: "failed",
  content: null,
  model: null,
  stopReason: null,
  errorCode,
  usage: null,
  cost: 0,
});

/** 1..n-1편의 검증된 헤드라인. 헤드라인이 없는 편에서 멈춘다(buildRequest가 순서대로 번호를 붙인다) */
function prevHeadlines(row: ConversationRow | null, n: number): string[] {
  const out: string[] = [];
  for (let k = 1; k < n; k++) {
    const e = row?.episodes.find((x) => x.n === k);
    const headline = e && (e.status === "done" || e.status === "partial") ? e.content?.headline : undefined;
    if (!headline) break;
    out.push(headline);
  }
  return out;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** 결과 → 저장할 상태·내용·오류 코드. 한도 오류면 먼저 정지 시각을 건다 */
async function judge(
  deps: JobDeps,
  payload: Payload,
  r: RunResult,
): Promise<{ status: string; content: unknown; errorCode: string | null }> {
  const validate = (raw: unknown, truncated: boolean) => validateEpisode(raw, payloadIndex(payload), payload.stats, { truncated });
  /** 끊긴 글에서 완결된 섹션만 살린다. done이어도 partial이다 */
  const salvage = (raw: string, failedCode: string) => {
    const v = validate(salvageEpisode(raw), true);
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
      return { status: "refused", content: null, errorCode: null };
    case "error": {
      const limit = r.error === "spend_limit" || r.error === "credit_exhausted";
      if (limit) {
        const now = new Date(deps.now());
        await deps.repo.setPaused(r.error === "spend_limit" ? nextMonthUtc(now) : nextCycleStart(now, CYCLE_ANCHOR_DAY));
      }
      const errorCode = limit ? "limit" : (r.error ?? "fatal");
      // 응답이 시작된 뒤 끊겼으면 받은 데까지 살린다(R8)
      if (r.startedStream && r.raw !== "") return salvage(r.raw, errorCode);
      return { status: "failed", content: null, errorCode };
    }
  }
}

/**
 * n편을 만들어 저장한다. 전제: 이 편은 이미 running이다(startEpisode가 true).
 * 1편은 응답이 시작되면 queued인 2~4편을 띄운다. 응답 전 일시 오류는 60초 안이면 1번만 다시 한다.
 * 던지지 않는다: 예상 못 한 오류는 failed(internal)로 남긴다
 */
export async function runEpisodeJob(deps: JobDeps, a: { id: string; n: EpisodeN; payload: Payload }): Promise<void> {
  const { repo, client } = deps;
  // 콜백 안에서 채우므로 객체에 둔다
  const pending: { dispatch?: Promise<void> } = {};
  try {
    if (!client) {
      await repo.finishEpisode(failure(a.id, a.n, "not_ready"));
      return;
    }
    const prev = a.n > 1 ? prevHeadlines(await repo.getConversation(a.id), a.n) : [];
    const req = buildRequest(a.payload, a.n, prev);
    const startedAt = deps.now();
    const deadlineAt = deps.deadlineAt();

    const onStreamStart = (model: string) => {
      if (model !== req.model) console.warn(`[jobs] fallback_on_writer: ${a.n}편 ${req.model} → ${model}`);
      if (a.n === 1 && !pending.dispatch) {
        pending.dispatch = repo.getConversation(a.id).then((row) => {
          const ns = (row?.episodes ?? []).filter((e) => e.n > 1 && e.status === "queued").map((e) => e.n as 2 | 3 | 4);
          return dispatchRest(deps, { id: a.id, payload: a.payload, ns });
        });
      }
    };
    const attempt = () =>
      runEpisode(client, req, { deadlineAt, onStreamStart, onNotes: (notes) => repo.saveProgress(a.id, a.n, notes) });

    let r = await attempt();
    if (r.kind === "error" && r.error === "retryable" && !r.startedStream && deps.now() - startedAt <= RETRY_WINDOW_MS) {
      r = await attempt();
    }

    const verdict = await judge(deps, a.payload, r);
    await repo.finishEpisode({
      id: a.id,
      n: a.n,
      ...verdict,
      model: r.startedStream ? r.model : null,
      stopReason: r.stopReason,
      usage: r.usage,
      cost: r.usage ? estimateCostUsd(r.usage, r.model) : 0,
    });
  } catch (e) {
    // 오류 문구에 출력 글이 섞일 수 있는 곳(JSON.parse)은 위에서 따로 잡는다. 여기는 DB 오류처럼 문구가 안전한 것들이다
    console.error(`[jobs] ${a.n}편 실행 실패: ${e instanceof Error ? e.message : "unknown"}`);
    await repo.finishEpisode(failure(a.id, a.n, "internal")).catch(() => {});
  } finally {
    await pending.dispatch?.catch((e) => console.error(`[jobs] 2~4편 띄우기 실패: ${e instanceof Error ? e.message : "unknown"}`));
  }
}
