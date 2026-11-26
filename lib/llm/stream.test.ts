import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { NOTES_FLUSH_MS } from "@/lib/config";
import { estimateCostUsd } from "./cost";
import { runReport } from "./stream";

// ── 가짜 fetch: 공식 SSE 형식(event: … / data: …)의 ReadableStream 응답 ──

type Ev = { type: string; [k: string]: unknown };
const enc = new TextEncoder();
const frame = (e: Ev) => enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);

const messageStart = (model = "claude-opus-5-5"): Ev => ({
  type: "message_start",
  message: {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 1, cache_creation_input_tokens: 128_000, cache_read_input_tokens: 0 },
  },
});
const textStart: Ev = { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
const delta = (text: string): Ev => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
const blockStop: Ev = { type: "content_block_stop", index: 0 };
const messageDelta = (stop_reason: string, output_tokens = 7_000, extra: { delta?: object; usage?: object } = {}): Ev => ({
  type: "message_delta",
  delta: { stop_reason, stop_sequence: null, ...extra.delta },
  usage: { output_tokens, ...extra.usage },
});
const messageStop: Ev = { type: "message_stop" };
const ping: Ev = { type: "ping" };

/** 본문 전체를 한 번에 보내는 정상 스트림 */
const whole = (text: string, stop = "end_turn", model?: string) => [
  messageStart(model),
  ping,
  textStart,
  delta(text.slice(0, 10)),
  delta(text.slice(10)),
  blockStop,
  messageDelta(stop),
  messageStop,
];

/**
 * 요청을 기록하고 SSE 응답을 돌려주는 fetch. initial을 먼저 보내고, end가 true면 닫는다.
 * push로 이벤트를 더 보낼 수 있다. abort 신호가 오면 실제 fetch처럼 본문을 AbortError로 끊는다
 */
function sse(initial: Ev[], end = true) {
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  const state = { aborted: false };
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
        for (const e of initial) c.enqueue(frame(e));
        if (end) c.close();
      },
    });
    init?.signal?.addEventListener("abort", () => {
      state.aborted = true;
      try {
        ctrl?.error(new DOMException("This operation was aborted", "AbortError"));
      } catch {
        // 이미 닫힘
      }
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const push = (...events: Ev[]) => events.forEach((e) => ctrl!.enqueue(frame(e)));
  const close = () => ctrl!.close();
  return { fetch, requests, push, close, state, raw: (chunk: string) => ctrl!.enqueue(enc.encode(chunk)) };
}

/** 오류 응답(JSON 본문)을 돌려주는 fetch */
const failing = (status: number, error: object) => async () =>
  new Response(JSON.stringify({ type: "error", error }), { status, headers: { "content-type": "application/json" } });

const client = (fetch: unknown) => new Anthropic({ apiKey: "test", fetch: fetch as typeof globalThis.fetch, maxRetries: 0 });

const REQ: BetaMessageStreamParams = {
  model: "claude-opus-5-5",
  max_tokens: 12_000,
  thinking: { type: "adaptive" },
  output_config: { effort: "medium" },
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
  system: "system",
  messages: [{ role: "user", content: "data" }],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await sleep(5);
  if (!cond()) throw new Error("조건이 1초 안에 채워지지 않았다");
}

type RunOpts = Parameters<typeof runReport>[2];
const opts = (over: { deadlineAt?: number; onNotes?: Mock<RunOpts["onNotes"]> } = {}) => ({
  deadlineAt: over.deadlineAt ?? Date.now() + 60_000,
  onStreamStart: vi.fn<RunOpts["onStreamStart"]>(),
  onNotes: over.onNotes ?? vi.fn<RunOpts["onNotes"]>(),
});

const BODY = '{"safety":{"flag":"none"},"declined_topics":[],"reading_notes":[],"headline":"h"}';

afterEach(() => {
  vi.useRealTimers();
});

describe("runReport", () => {
  it("정상 종료 → ok. raw는 text delta 누적, usage·model은 finalMessage에서", async () => {
    const s = sse(whole(BODY));
    const r = await runReport(client(s.fetch), REQ, opts());
    expect(r).toEqual({
      kind: "ok",
      raw: BODY,
      stopReason: "end_turn",
      model: "claude-opus-5-5",
      usage: { input_tokens: 120, output_tokens: 7_000, cache_creation_input_tokens: 128_000, cache_read_input_tokens: 0 },
      stopCategory: null,
      startedStream: true,
    });
  });

  it("요청: beta 경로, betas는 헤더로, fallbacks·stream은 본문으로", async () => {
    const s = sse(whole(BODY));
    await runReport(client(s.fetch), REQ, opts());
    expect(s.requests).toHaveLength(1);
    const [req] = s.requests;
    expect(req.url).toContain("/v1/messages?beta=true");
    expect(req.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(req.body).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", stream: true, max_tokens: 12_000 });
    expect(req.body).not.toHaveProperty("betas");
  });

  it("refusal → refused, max_tokens → truncated", async () => {
    const refused = await runReport(client(sse(whole(BODY, "refusal")).fetch), REQ, opts());
    expect(refused).toMatchObject({ kind: "refused", stopReason: "refusal", startedStream: true });
    const truncated = await runReport(client(sse(whole(BODY, "max_tokens")).fetch), REQ, opts());
    expect(truncated).toMatchObject({ kind: "truncated", stopReason: "max_tokens", raw: BODY });
  });

  it("거절 분류(stop_details.category)는 stopCategory로, 없으면 null. 생각 토큰(thinking_tokens)도 넘긴다", async () => {
    const stopDetails = { type: "refusal", category: "cyber", explanation: "거절 이유" };
    const refused = await runReport(
      client(
        sse([
          messageStart(),
          textStart,
          delta("{}"),
          blockStop,
          messageDelta("refusal", 300, { delta: { stop_details: stopDetails }, usage: { output_tokens_details: { thinking_tokens: 120 } } }),
          messageStop,
        ]).fetch,
      ),
      REQ,
      opts(),
    );
    expect(refused).toMatchObject({ kind: "refused", stopCategory: "cyber", thinkingTokens: 120 });
    // 분류가 null인 거절
    const unnamed = await runReport(
      client(sse([messageStart(), messageDelta("refusal", 1, { delta: { stop_details: { ...stopDetails, category: null } } }), messageStop]).fetch),
      REQ,
      opts(),
    );
    expect(unnamed).toMatchObject({ kind: "refused", stopCategory: null });
    expect(unnamed.thinkingTokens).toBeUndefined();
    const ok = await runReport(client(sse(whole(BODY)).fetch), REQ, opts());
    expect(ok.stopCategory).toBeNull();
    expect(ok).not.toHaveProperty("thinkingTokens");
  });

  it("onStreamStart는 message_start에서 정확히 1번, 텍스트 전에 실제 모델로 불린다", async () => {
    const s = sse([messageStart("claude-opus-4-8")], false);
    const o = opts();
    const done = runReport(client(s.fetch), { ...REQ }, o);
    await until(() => o.onStreamStart.mock.calls.length > 0);
    // 아직 텍스트를 하나도 보내지 않았다
    expect(o.onStreamStart).toHaveBeenCalledTimes(1);
    expect(o.onStreamStart).toHaveBeenCalledWith("claude-opus-4-8");
    s.push(textStart, delta(BODY), blockStop, messageDelta("end_turn"), messageStop);
    s.close();
    const r = await done;
    expect(o.onStreamStart).toHaveBeenCalledTimes(1);
    expect(r.kind).toBe("ok");
    expect(r.raw).toBe(BODY);
    expect(r.model).toBe("claude-opus-4-8");
  });

  it("SSE가 deadline을 넘기면 abort하고 partial. usage는 currentMessage에서, 출력은 max_tokens 상한으로 센다", async () => {
    const s = sse([messageStart(), textStart, delta('{"safety":{"flag":"none"},"rea')], false);
    const r = await runReport(client(s.fetch), REQ, opts({ deadlineAt: Date.now() + 80 }));
    expect(s.state.aborted).toBe(true);
    expect(r).toEqual({
      kind: "partial",
      raw: '{"safety":{"flag":"none"},"rea',
      stopReason: null,
      model: "claude-opus-5-5",
      // 입력·캐시는 message_start 값 그대로, 출력은 message_start 값(1) 대신 max_tokens(thinking 포함 상한)
      usage: { input_tokens: 120, output_tokens: 12_000, cache_creation_input_tokens: 128_000, cache_read_input_tokens: 0 },
      usageEstimated: true,
      stopCategory: null,
      startedStream: true,
    });
    // 원장 원가: 캐시 쓰기 128K($0.64) + 입력 120 + 출력 12K($0.24)
    expect(estimateCostUsd(r.usage!, r.model)).toBeCloseTo(0.64 + 0.00048 + 0.24, 5);
  });

  it("끊긴 편에 iterations가 있으면 마지막(진행 중이던) 항목의 출력도 상한으로 센다", async () => {
    const start = messageStart();
    const msg = start.message as { usage: Record<string, unknown> };
    msg.usage = {
      ...msg.usage,
      iterations: [
        { type: "message", model: "claude-opus-5-5", input_tokens: 120, output_tokens: 300 },
        { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 120, output_tokens: 1 },
      ],
    };
    const s = sse([start, textStart, delta('{"safety":')], false);
    const r = await runReport(client(s.fetch), REQ, opts({ deadlineAt: Date.now() + 80 }));
    expect(r.kind).toBe("partial");
    expect(r.usageEstimated).toBe(true);
    expect(r.usage?.iterations?.map((it) => [it.model, it.output_tokens])).toEqual([
      ["claude-opus-5-5", 300],
      ["claude-opus-4-8", 12_000],
    ]);
  });

  it("응답 시작 전에 deadline이 지나면 partial, startedStream false, usage는 null(추정 없음)", async () => {
    const s = sse([], false);
    const r = await runReport(client(s.fetch), REQ, opts({ deadlineAt: Date.now() + 30 }));
    expect(r).toMatchObject({ kind: "partial", raw: "", usage: null, startedStream: false, model: "claude-opus-5-5" });
    expect(r.usageEstimated).toBeUndefined();
  });

  it("HTTP 오류는 classifyError로 분류한 error (재시도 없음)", async () => {
    let calls = 0;
    const overloaded = failing(529, { type: "overloaded_error", message: "Overloaded" });
    const r = await runReport(
      client(async () => {
        calls++;
        return overloaded();
      }),
      REQ,
      opts(),
    );
    expect(calls).toBe(1);
    expect(r).toMatchObject({ kind: "error", error: "retryable", startedStream: false, usage: null, raw: "" });
    expect(r.usageEstimated).toBeUndefined();
    const spend = await runReport(
      client(
        failing(429, {
          type: "rate_limit_error",
          message: "spend limit",
          details: { error_code: "enforced_spend_limit_reached" },
        }),
      ),
      REQ,
      opts(),
    );
    expect(spend).toMatchObject({ kind: "error", error: "spend_limit" });
  });

  it("스트림 중간 SSE overloaded_error → error retryable, startedStream true", async () => {
    const s = sse([messageStart(), textStart, delta('{"safety":')], false);
    const o = opts();
    const done = runReport(client(s.fetch), REQ, o);
    await until(() => o.onStreamStart.mock.calls.length > 0);
    s.raw(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}\n\n`);
    const r = await done;
    expect(r).toMatchObject({ kind: "error", error: "retryable", startedStream: true, raw: '{"safety":' });
    expect(r.usage?.cache_creation_input_tokens).toBe(128_000);
    // 응답이 시작된 뒤 끊겼으니 출력은 max_tokens 상한으로 센다
    expect(r.usage?.output_tokens).toBe(12_000);
    expect(r.usageEstimated).toBe(true);
  });

  it("NOTES_FLUSH_MS마다 정리된 reading_notes를 onNotes로 넘긴다(바뀌었을 때만)", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const s = sse(
      [
        messageStart(),
        textStart,
        delta('{"safety":{"flag":"none"},"declined_topics":[],"reading_notes":[{"range":"10-01~10-03","note":"저녁마다 짧게"},'),
      ],
      false,
    );
    const o = opts();
    const done = runReport(client(s.fetch), REQ, o);
    await until(() => o.onStreamStart.mock.calls.length > 0);
    await sleep(20);
    expect(o.onNotes).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(NOTES_FLUSH_MS);
    expect(o.onNotes).toHaveBeenCalledTimes(1);
    expect(o.onNotes).toHaveBeenLastCalledWith([{ range: "10-01~10-03", note: "저녁마다 짧게" }]);

    // 새 메모가 없으면 다시 부르지 않는다
    await vi.advanceTimersByTimeAsync(NOTES_FLUSH_MS);
    expect(o.onNotes).toHaveBeenCalledTimes(1);

    // 금지 표현이 든 메모는 빼고, 61자 메모는 60자로 자른다
    s.push(delta(`{"range":"10-04","note":"속으로 좋아하는 것 같다"},{"range":"10-05","note":"${"가".repeat(61)}"}]`));
    await sleep(20);
    await vi.advanceTimersByTimeAsync(NOTES_FLUSH_MS);
    expect(o.onNotes).toHaveBeenCalledTimes(2);
    expect(o.onNotes).toHaveBeenLastCalledWith([
      { range: "10-01~10-03", note: "저녁마다 짧게" },
      { range: "10-05", note: "가".repeat(60) },
    ]);

    s.push(delta("}"), blockStop, messageDelta("end_turn"), messageStop);
    s.close();
    expect((await done).kind).toBe("ok");
  });

  it("onNotes가 던져도 생성은 계속된다", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const s = sse([messageStart(), textStart, delta('{"reading_notes":[{"range":"r","note":"n"},')], false);
    const o = opts({
      onNotes: vi.fn<RunOpts["onNotes"]>(() => {
        throw new Error("db down");
      }),
    });
    const done = runReport(client(s.fetch), REQ, o);
    await until(() => o.onStreamStart.mock.calls.length > 0);
    await sleep(20);
    await vi.advanceTimersByTimeAsync(NOTES_FLUSH_MS);
    expect(o.onNotes).toHaveBeenCalledTimes(1);
    s.push(delta("]}"), blockStop, messageDelta("end_turn"), messageStop);
    s.close();
    expect((await done).kind).toBe("ok");
  });
});
