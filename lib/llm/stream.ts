// 편 하나를 스트리밍으로 받는다. 서버 전용.
// deadlineAt에 끊고(완결된 섹션은 호출하는 쪽이 salvageEpisode로 살린다), 첫 message_start에서 실제 모델을 알리고,
// 스트리밍 중에는 NOTES_FLUSH_MS마다 정리된 reading_notes만 내보낸다. 출력 원문은 로그에 남기지 않는다.
import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams, BetaUsage } from "@anthropic-ai/sdk/resources/beta/messages";
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
  error?: ErrorClass;
  /** message_start를 받았는지. 받기 전 오류만 같은 함수에서 재시도할 수 있다 */
  startedStream: boolean;
}

type Note = { range: string; note: string };

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

export async function runEpisode(
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
    // 진행 메모는 표시용이라, 저장이 실패해도(동기 throw든 reject든) 편 생성을 멈추지 않는다
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
      startedStream: startModel !== null,
    };
  } catch (e) {
    const current = stream.currentMessage;
    const model = current?.model ?? startModel ?? req.model;
    const base = {
      raw,
      stopReason: current?.stop_reason ?? null,
      model,
      usage: toUsage(current?.usage, model),
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
