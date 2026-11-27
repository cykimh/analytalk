// 리포트 한 편을 호출 3~4개로 나눠 쓰고 합친다(v2.5). 서버 전용. 생성 작업(lib/server/jobs.ts)과 측정·평가 스크립트가 같이 쓴다.
// 순서: ① 인트로를 먼저 시작하고, ①의 message_start(그때는 캐시가 써져 있다)에서 ②(·②b)·③을 같은 함수 안에서 동시에 시작한다
//   (별도 내부 라우트 없이 Promise로). 캐시는 첫 응답이 스트리밍을 시작한 뒤에야 읽을 수 있어서, 동시에 모두 보내면 셋 다 캐시를 쓴다.
//   모든 호출이 같은 마감(① 시작 기준 deadlineAt)을 쓴다.
// 재시도: 응답 전(message_start 전) 일시 오류는 실행 시작부터 retryWindowMs 안이면 그 호출만 1번 다시 한다(①은 v2.4까지와 같다.
//   ②·③도 같은 규칙: 응답 전 실패는 원가가 없다). 429에 retry-after가 있으면 그만큼 기다린 뒤 다시 한다(리뷰 minor 2).
//   기다린 뒤가 재시도 창이나 마감을 넘으면 다시 하지 않는다. ①이 끝내 응답을 시작하지 못하면 나머지는 시작하지 않는다(캐시 없이 셋이 쓰면 원가가 세 배).
// 합치기: 호출마다 구조를 보고(끊긴 것은 완결 섹션만 살려) ①→②→③ 순서로 섹션을 붙이고 한 번 검증한다(인용 몫·마무리 몫·삭제율이 리포트 단위다).
//   어느 호출이든 safety면 safety. 실패한 호출의 몫은 빠지고 partial이다. 다른 호출 몫의 섹션(다른 자리의 구성, 다른 개인별 호출이 맡은 사람)은 뺀다.
//   headline·dek·reading_notes·chemistry(v2.8 케미 온도)는 ①의 것이다. usage는 호출마다 더하고 원가는 호출마다 계산해 더한다(원장 한 행 = 실행 한 번).
// 출력 원문·대화 내용은 로그에 남기지 않는다.
import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { estimateCostUsd, type Usage } from "./cost";
import type { ErrorClass } from "./errors";
import { salvageReport } from "./notes";
import type { CallPart, ReportCall } from "./prompt";
import type { Report, StoredReport } from "./schema";
import { type RunResult, runReport } from "./stream";
import { parseReport, validateReport } from "./validate";
import { memberCodes, type Payload, payloadIndex } from "@/lib/payload/build";
import { TONES } from "./concepts";

type Note = { range: string; note: string };

export interface CallResult {
  call: ReportCall;
  /** 시작하지 않았으면 null(①이 응답을 시작하지 못했다) */
  r: RunResult | null;
}

/**
 * 호출들을 돌린다. calls[0](①)을 먼저 시작하고 그 message_start에서 나머지를 동시에 시작한다. 던지지 않는다.
 * onNotes는 ①의 진행 메모만 받는다. onStreamStart는 호출마다 실제 응답 모델을 알린다
 */
export async function runReportCalls(
  client: Anthropic,
  calls: ReportCall[],
  opts: {
    deadlineAt: number;
    now: () => number;
    /** 응답 전 일시 오류를 다시 해 볼 수 있는 시간(실행 시작부터) */
    retryWindowMs: number;
    onNotes: (notes: Note[]) => void;
    /** 호출마다 첫 message_start에서: 실제 응답 모델, 요청 모델, 그때 읽은 캐시 토큰 */
    onStreamStart?: (part: CallPart, model: string, requested: string, cacheRead: number) => void;
  },
): Promise<CallResult[]> {
  const startedAt = opts.now();
  const run = async (call: ReportCall, hooks: { onStart?: () => void; onNotes?: (notes: Note[]) => void }): Promise<CallResult> => {
    const attempt = () =>
      runReport(client, call.req, {
        deadlineAt: opts.deadlineAt,
        onStreamStart: (model, usage) => {
          opts.onStreamStart?.(call.part, model, call.req.model, usage.cache_read_input_tokens);
          hooks.onStart?.();
        },
        onNotes: hooks.onNotes ?? (() => {}),
      });
    // runReport는 응답 오류를 결과로 돌려준다. 그래도 던지면(요청을 만들다 실패) 그 호출만 fatal로 둔다:
    // ②·③의 Promise는 ①이 끝날 때까지 아무도 기다리지 않아서, 거절되면 처리되지 않은 거절로 함수가 죽을 수 있다
    const safely = () =>
      attempt().catch(
        (): RunResult => ({ kind: "error", error: "fatal", raw: "", stopReason: null, model: call.req.model, usage: null, stopCategory: null, startedStream: false }),
      );
    let r = await safely();
    if (r.kind === "error" && r.error === "retryable" && !r.startedStream) {
      const wait = r.retryAfterMs ?? 0;
      if (opts.now() + wait - startedAt <= opts.retryWindowMs && Date.now() + wait < opts.deadlineAt) {
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        r = await safely();
      }
    }
    return { call, r };
  };

  const [first, ...rest] = calls;
  let later: Promise<CallResult>[] | null = null;
  const startRest = () => {
    later ??= rest.map((call) => run(call, {}));
  };
  const head = await run(first, { onStart: startRest, onNotes: opts.onNotes });
  const tail = later === null ? rest.map((call) => ({ call, r: null })) : await Promise.all(later as Promise<CallResult>[]);
  return [head, ...tail];
}

// ===== 합치기 =====

/** 호출 하나의 결과를 부르는 말(checks.calls·오류 코드). ok가 아니면 그 몫이 빠졌거나 끊겼다 */
type CallCode =
  | "ok"
  | "empty"
  | "max_tokens"
  | "timeout"
  | "refused"
  | "limit"
  | "invalid_output"
  | "not_started"
  | "safety"
  | Exclude<ErrorClass, "spend_limit" | "credit_exhausted">;

interface Piece {
  call: ReportCall;
  r: RunResult | null;
  code: CallCode;
  report: Report | null;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** 호출 하나: 결과 분류와 살린 리포트(구조만 본 것). 끊긴 출력은 완결된 섹션만 살린다 */
function pieceOf({ call, r }: CallResult): Piece {
  if (r === null) return { call, r, code: "not_started", report: null };
  const parse = (raw: unknown, truncated: boolean, code: CallCode): Piece => {
    const parsed = parseReport(raw, truncated);
    if (parsed.kind === "safety") return { call, r, code: "safety", report: null };
    if (parsed.kind === "failed") return { call, r, code: code === "ok" ? "invalid_output" : code, report: null };
    return { call, r, code, report: parsed.report };
  };
  switch (r.kind) {
    case "ok":
      return parse(parseJson(r.raw), false, "ok");
    case "truncated":
      return parse(salvageReport(r.raw), true, "max_tokens");
    case "partial":
      return parse(salvageReport(r.raw), true, "timeout");
    case "refused":
      return { call, r, code: "refused", report: null };
    case "error": {
      const code: CallCode = r.error === "spend_limit" || r.error === "credit_exhausted" ? "limit" : (r.error ?? "fatal");
      // 응답이 시작된 뒤 끊겼으면 받은 데까지 살린다(R8)
      if (r.startedStream && r.raw !== "") return parse(salvageReport(r.raw), true, code);
      return { call, r, code, report: null };
    }
  }
}

export interface MergedReport {
  status: "done" | "partial" | "safety" | "failed" | "refused";
  content: StoredReport | null;
  /** done·partial·safety는 null(잘라 살린 partial은 오류 코드가 없다: 화면은 오류 코드가 있는 partial을 '다시 쓰기 실패'로 읽는다) */
  errorCode: string | null;
  /** 한도 오류가 난 호출이 있으면 그 종류. 부르는 쪽이 정지 시각을 건다 */
  limit: "spend_limit" | "credit_exhausted" | null;
  /** 응답을 시작한 첫 호출의 실제 모델. 아무도 시작하지 않았으면 null */
  model: string | null;
  /** end_turn이 아닌 첫 호출의 stop_reason, 모두 end_turn이면 end_turn */
  stopReason: string | null;
  usage: Usage | null;
  cost: number;
  /** 합친 출력(검증 전, 다른 몫 섹션을 뺀 것). 살린 것이 없으면 null. 평가 스크립트가 채점에 쓴다 */
  raw: Report | null;
  /** ok가 아닌 첫 호출의 결과(모두 ok면 ok). 측정·평가 스크립트용 */
  kind: string;
}

/** usage 합. 원장은 네 칸만 읽는다. 원가는 호출마다 따로 계산해 더한다(모델이 다를 수 있다) */
function sumUsage(items: Usage[]): Usage | null {
  if (items.length === 0) return null;
  const total: Usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  for (const u of items) {
    total.input_tokens += u.input_tokens;
    total.output_tokens += u.output_tokens;
    total.cache_creation_input_tokens += u.cache_creation_input_tokens;
    total.cache_read_input_tokens += u.cache_read_input_tokens;
  }
  return total;
}

/**
 * 호출들이 쓴 것: usage 합, 원가 합(호출마다 계산), 응답을 시작한 첫 호출의 실제 모델.
 * 합치기가 던져도 원장에 남길 수 있게 따로 둔다(리뷰 minor 4: jobs의 catch에서도 쓴다)
 */
export function spentOf(results: CallResult[]): { usage: Usage | null; cost: number; model: string | null } {
  const ran = results.flatMap(({ r }) => (r ? [r] : []));
  const usages = ran.flatMap((r) => (r.usage ? [{ usage: r.usage, model: r.model }] : []));
  return {
    usage: sumUsage(usages.map((u) => u.usage)),
    cost: usages.reduce((sum, u) => sum + estimateCostUsd(u.usage, u.model), 0),
    model: ran.find((r) => r.startedStream)?.model ?? null,
  };
}

/**
 * 나눠 쓴 결과를 합쳐 저장할 값으로. 순서: safety(어느 호출이든) → 다른 몫 섹션 빼기 → 살린 섹션이 없으면 failed·refused → 검증(합친 리포트 한 번).
 * 응답은 끝났는데 자기 몫 섹션이 하나도 없는 호출은 empty다(그 부분이 빠졌으니 partial: [다시 쓰기]가 보인다).
 * 오류 코드는 한도 오류가 있으면 limit, 아니면 ok가 아닌 첫 호출의 코드. 모든 시작한 호출이 거절했으면 refused
 */
export function mergeReportCalls(payload: Payload, results: CallResult[]): MergedReport {
  const pieces = results.map(pieceOf);
  const started = pieces.filter((x) => x.r !== null && x.r.startedStream);
  const limitHit = pieces.find((x) => x.r?.kind === "error" && (x.r.error === "spend_limit" || x.r.error === "credit_exhausted"));
  const base = {
    ...spentOf(results),
    limit: limitHit ? (limitHit.r!.error as "spend_limit" | "credit_exhausted") : null,
    stopReason: (started.find((x) => x.r!.stopReason !== "end_turn") ?? started[0])?.r!.stopReason ?? null,
  };
  const kindOf = (bad: Piece | undefined) => (bad ? (bad.code === "empty" ? "ok" : (bad.r?.kind ?? "not_started")) : "ok");
  if (pieces.some((x) => x.code === "safety")) {
    return { ...base, kind: kindOf(pieces.find((x) => x.code !== "ok")), status: "safety", content: null, errorCode: null, raw: null };
  }

  // 다른 몫의 섹션을 뺀다: 다른 자리의 구성(모르는 키는 둔다), 다른 개인별 호출이 맡은 사람, 앞 호출이 이미 쓴 사람.
  // 한 호출 안에서 같은 사람을 두 번 쓴 것은 그 호출의 구성으로 보고 둔다
  const stageOf = new Map<string, string>(TONES[payload.tone].parts.map((p) => [p.key, p.stage]));
  const assigned = new Map<string, ReportCall>();
  for (const x of pieces) for (const name of x.call.people) assigned.set(name, x.call);
  const members = new Set(payload.members);
  // 지시가 사람을 범례 기호로 부르므로 about에 기호(B, G…)를 그대로 쓸 수 있다. 맡은 사람 판정 전에 표시 이름으로 바꾼다(리뷰 minor 6)
  const nameOfCode = new Map(memberCodes(payload.members).map((code, i) => [code, payload.members[i]]));
  const writer = new Map<string, ReportCall>();
  let offStage = 0;
  const sections = pieces.flatMap((x) => {
    const named = (x.report?.sections ?? []).map((s) => (members.has(s.about) || !nameOfCode.has(s.about) ? s : { ...s, about: nameOfCode.get(s.about)! }));
    const kept = named.filter((s) => {
      const stage = stageOf.get(s.part);
      const person = x.call.stages.includes("people") && members.has(s.about);
      const other = (owner: ReportCall | undefined) => owner !== undefined && owner !== x.call;
      const mine = (stage === undefined || (x.call.stages as string[]).includes(stage)) && !(person && (other(assigned.get(s.about)) || other(writer.get(s.about))));
      if (!mine) offStage++;
      else if (person) writer.set(s.about, x.call);
      return mine;
    });
    if (x.code === "ok" && kept.length === 0) x.code = "empty";
    return kept;
  });
  const notOk = pieces.find((x) => x.code !== "ok");
  const common = { ...base, kind: kindOf(notOk) };
  const calls = Object.fromEntries(pieces.map((x) => [x.call.part, x.code]));
  const codeFor = (fallback: string) => (limitHit ? "limit" : notOk && notOk.code !== "not_started" && notOk.code !== "empty" ? notOk.code : fallback);
  const intro = pieces.find((x) => x.call.part === "intro")?.report ?? null;

  if (sections.length === 0) {
    const refusedAll = started.length > 0 && started.every((x) => x.code === "refused");
    if (refusedAll && !limitHit) {
      // 거절 분류만 남긴다(문구 없는 열거값이라 출력 글·이름이 섞이지 않는다). ①의 것을 먼저 본다
      const category = started[0].r!.stopCategory;
      return { ...common, status: "refused", content: null, errorCode: category ? `refusal_${category}` : null, raw: null };
    }
    return { ...common, status: "failed", content: null, errorCode: codeFor("invalid_output"), raw: null };
  }

  const raw: Report = {
    safety: { flag: "none" },
    declined_topics: [...new Set(pieces.flatMap((x) => x.report?.declined_topics ?? []))],
    reading_notes: intro?.reading_notes ?? [],
    headline: intro?.headline ?? "",
    dek: intro?.dek ?? "",
    // v2.8: 케미 온도는 ①이 맡는다(다른 응답이 쓴 것은 버린다). MBTI는 개인별 응답의 사람 섹션에 붙어 온다
    chemistry: intro?.chemistry ?? null,
    sections,
  };
  const v = validateReport(raw, payloadIndex(payload), payload.stats, {
    truncated: notOk !== undefined,
    tone: payload.tone,
    members: payload.members,
  });
  // 합친 raw의 safety는 none이라 safety가 나오지 않는다. 섹션이 다 지워지면 failed
  if (v.status !== "done" && v.status !== "partial") return { ...common, status: "failed", content: null, errorCode: codeFor("invalid_output"), raw };
  const content: StoredReport = { ...v.content!, checks: { ...v.dropped.checks, calls, off_stage: offStage } };
  return { ...common, status: v.status, content, errorCode: null, raw };
}
