// 리포트 호출 하나를 스트리밍으로 받는다(v2.5: 한 편은 호출 3~4개로 나눠 쓰고 lib/llm/split.ts가 돌린다). 서버 전용.
// deadlineAt에 끊고(완결된 섹션은 호출하는 쪽이 salvageReport로 살린다), 첫 message_start에서 실제 모델을 알리고,
// 스트리밍 중에는 NOTES_FLUSH_MS마다 정리된 reading_notes만 내보낸다. 출력 원문은 로그에 남기지 않는다.
// 응답이 시작된 뒤 끊긴 실행은 출력량을 알 수 없어 max_tokens 상한으로 센다(원장이 차단 원가를 낮게 세지 않게).
import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, BetaMessageStreamParams, BetaUsage } from "@anthropic-ai/sdk/resources/beta/messages";
import { NOTES_FLUSH_MS } from "@/lib/config";
import type { Usage } from "./cost";
import { classifyError, type ErrorClass } from "./errors";
import { extractReadingNotes, sanitizeNotes } from "./notes";

export interface RunResult {
  kind: "ok" | "partial" | "refused" | "truncated" | "error";
  /** text delta를 이어 붙인 출력(JSON). 서버 측 fallback이 중간에 이어 써도 이어진다 */
  raw: string;
  stopReason: string | null;
  /** 실제로 응답한 모델 */
  model: string;
  usage: Usage | null;
  /** usage의 출력 토큰이 실측이 아니라 max_tokens 상한인지. message_start 뒤에 끊긴 실행(partial·error)에서만 true */
  usageEstimated?: boolean;
  /** 거절 분류(stop_details.category: cyber·bio·general_harms…). 거절이 아니거나 분류가 없으면 null */
  stopCategory: string | null;
  /** 출력 토큰 중 생각(adaptive thinking) 몫. 응답이 알려 줄 때만 */
  thinkingTokens?: number;
  error?: ErrorClass;
  /** message_start를 받았는지. 받기 전 오류만 같은 함수에서 재시도할 수 있다 */
  startedStream: boolean;
}

type Note = { range: string; note: string };

/** 메시지(완결 또는 끊긴 스냅샷)의 거절 분류와 생각 토큰 */
function stopInfo(m: BetaMessage | undefined): Pick<RunResult, "stopCategory" | "thinkingTokens"> {
  const thinking = m?.usage?.output_tokens_details?.thinking_tokens;
  return { stopCategory: m?.stop_details?.category ?? null, ...(thinking === undefined ? {} : { thinkingTokens: thinking }) };
}

/** SDK usage(캐시 값 null 가능)를 원장용 Usage로. 모델이 없는 iteration 항목은 응답 모델로 본다 */
function toUsage(u: BetaUsage | undefined, model: string): Usage | null {
  if (!u) return null;
  const usage: Usage = {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
  };
  if (u.iterations?.length) {
    usage.iterations = u.iterations.map((it) => ({
      type: it.type,
      model: ("model" in it && it.model) || model,
      input_tokens: it.input_tokens,
      output_tokens: it.output_tokens,
      cache_creation_input_tokens: it.cache_creation_input_tokens,
      cache_read_input_tokens: it.cache_read_input_tokens,
    }));
  }
  return usage;
}

/**
 * message_start 뒤에 끊긴 실행(마감 abort, 스트림 중간 오류)의 usage.
 * output_tokens는 message_delta가 와야 갱신되므로 끊긴 스트림에서는 message_start 값(1)이고,
 * adaptive thinking 토큰은 raw에도 없어 다시 셀 수 없다. 그래서 출력은 max_tokens(thinking 포함 상한)만큼 쓴 것으로 본다.
 * iterations가 있으면 원가를 그것으로 계산하므로, 마지막(진행 중이던) 항목에도 같은 상한을 둔다
 */
function cutUsage(u: Usage, maxTokens: number): Usage {
  const usage: Usage = { ...u, output_tokens: Math.max(u.output_tokens, maxTokens) };
  if (u.iterations?.length) {
    const last = u.iterations.length - 1;
    usage.iterations = u.iterations.map((it, i) =>
      i === last ? { ...it, output_tokens: Math.max(it.output_tokens, maxTokens) } : it,
    );
  }
  return usage;
}

export async function runReport(
  client: Anthropic,
  req: BetaMessageStreamParams,
  opts: { deadlineAt: number; onStreamStart: (model: string) => void; onNotes: (notes: Note[]) => void },
): Promise<RunResult> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), Math.max(0, opts.deadlineAt - Date.now()));
  let raw = "";
  let startModel: string | null = null;

  let flushedRaw = "";
  let flushedNotes = "[]";
  const flush = () => {
    if (raw === flushedRaw) return;
    flushedRaw = raw;
    const notes = sanitizeNotes(extractReadingNotes(raw));
    const key = JSON.stringify(notes);
    if (key === flushedNotes) return;
    flushedNotes = key;
    // 진행 메모는 표시용이라, 저장이 실패해도(동기 throw든 reject든) 리포트 생성을 멈추지 않는다
    Promise.resolve()
      .then(() => opts.onNotes(notes))
      .catch(() => {});
  };
  const ticker = setInterval(flush, NOTES_FLUSH_MS);

  const stream = client.beta.messages.stream(req, { signal: controller.signal });
  stream.on("streamEvent", (event) => {
    if (event.type === "message_start" && startModel === null) {
      startModel = event.message.model;
      opts.onStreamStart(startModel);
    } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      raw += event.delta.text;
    }
  });

  try {
    const final = await stream.finalMessage();
    const kind = final.stop_reason === "refusal" ? "refused" : final.stop_reason === "max_tokens" ? "truncated" : "ok";
    return {
      kind,
      raw,
      stopReason: final.stop_reason,
      model: final.model,
      usage: toUsage(final.usage, final.model),
      ...stopInfo(final),
      startedStream: startModel !== null,
    };
  } catch (e) {
    const current = stream.currentMessage;
    const model = current?.model ?? startModel ?? req.model;
    const measured = toUsage(current?.usage, model);
    // 응답이 시작된 뒤 끊겼으면 출력은 상한으로 센다. 시작 전이면 usage가 없다(받은 토큰이 없다)
    const estimated = startModel !== null && measured !== null;
    const base = {
      raw,
      stopReason: current?.stop_reason ?? null,
      model,
      usage: estimated ? cutUsage(measured, req.max_tokens) : measured,
      ...(estimated ? { usageEstimated: true } : {}),
      ...stopInfo(current),
      startedStream: startModel !== null,
    };
    // 마감으로 끊은 것은 오류가 아니다: 받은 데까지 partial
    if (controller.signal.aborted || Date.now() >= opts.deadlineAt) return { kind: "partial", ...base };
    return { kind: "error", error: classifyError(e), ...base };
  } finally {
    clearTimeout(deadline);
    clearInterval(ticker);
  }
}
