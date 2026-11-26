import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, inputTokenBudgetFor, PROMPT_RESERVE_TOKENS, TOKENS_PER_CHAR } from "@/lib/config";
import { buildPayload, payloadTokens } from "@/lib/payload/build";
import type { ChatMessage } from "@/lib/parse/parse";
import { syntheticGroupChat } from "@/test/syntheticChat";
import {
  displayNames,
  judge,
  measurePayload,
  measureRun,
  measureTokens,
  parseArgs,
  percentile,
  summarize,
  type RunMeasure,
} from "./measure";

describe("parseArgs", () => {
  it("파일만 주면 기본값: group, 1회, 실제 실행", () => {
    expect(parseArgs(["a.txt"])).toEqual({ file: "a.txt", concept: "group", runs: 1, dryRun: false });
  });
  it("옵션을 읽는다", () => {
    expect(parseArgs(["a.txt", "--concept", "couple", "--runs", "2", "--dry-run"])).toEqual({
      file: "a.txt",
      concept: "couple",
      runs: 2,
      dryRun: true,
    });
  });
  it.each([
    [[], /샘플 파일/],
    [["a.txt", "--concept", "work"], /concept/],
    [["a.txt", "--runs", "0"], /runs/],
    [["a.txt", "--runs", "x"], /runs/],
    [["a.txt", "--bogus"], /알 수 없는/],
    [["a.txt", "b.txt"], /하나/],
  ])("잘못된 인자 %j 는 던진다", (argv, msg) => {
    expect(() => parseArgs(argv as string[])).toThrow(msg);
  });
});

describe("displayNames", () => {
  it("발신자에게 카톡 이름 그대로(금지 글자만 정리)를 준다", () => {
    expect(displayNames({ participants: ["철수", "영희.", "a|b", ""] })).toEqual({ 철수: "철수", "영희.": "영희", "a|b": "ab" });
  });
});

describe("measurePayload", () => {
  const messages = syntheticGroupChat(40, 60);

  it("통계 요약과 프롬프트 몫까지 입력 예산 안에 들고, transcript가 있다", () => {
    const p = measurePayload(messages, "group");
    expect(payloadTokens(p, TOKENS_PER_CHAR).total + PROMPT_RESERVE_TOKENS).toBeLessThanOrEqual(inputTokenBudgetFor(DEFAULT_MODEL));
    expect(p.msgSent).toBeGreaterThan(0);
    expect(p).toMatchObject({ v: 2, tone: "fact", concept: "group", kind: "group" });
  });

  it("couple 컨셉은 kind pair", () => {
    expect(measurePayload(messages, "couple")).toMatchObject({ concept: "couple", kind: "pair" });
  });
});

describe("percentile", () => {
  it("올림 순위(nearest-rank)", () => {
    expect(percentile([10, 20, 30, 40], 0.95)).toBe(40);
    expect(percentile([5], 0.95)).toBe(5);
    expect(percentile([], 0.95)).toBe(0);
  });
});

const ep = (n: number, ttft: number, total: number, cacheRead: number, cost: number): RunMeasure["episodes"][number] => ({
  n,
  ttftMs: ttft,
  totalMs: total,
  outputTokens: 7000,
  cacheReadTokens: cacheRead,
  cacheCreationTokens: n === 1 ? 100_000 : 0,
  costUsd: cost,
  status: "done",
  kind: "ok",
});
const run = (over: Partial<RunMeasure["episodes"][number]>[] = []): RunMeasure => ({
  episodes: [1, 2, 3, 4].map((n, i) => ({ ...ep(n, 2000, 100_000, n === 1 ? 0 : 90_000, 0.3), ...over[i] })),
});

describe("summarize / judge", () => {
  it("원가 합·편별 p95·캐시 읽기를 모은다", () => {
    const s = summarize([run(), run([{ totalMs: 230_000 }])]);
    expect(s.runs).toBe(2);
    expect(s.costUsdPerRun).toEqual([1.2, 1.2]);
    expect(s.costUsdTotal).toBeCloseTo(2.4, 10);
    expect(s.p95TotalMs).toBe(230_000);
    expect(s.cacheReadOk).toBe(true);
  });
  it("통과 기준: p95 240초 이하, 2~4편 캐시 읽기 > 0, 원가 0.92~1.70", () => {
    expect(judge(summarize([run()]))).toEqual({ p95: true, cache: true, cost: true, pass: true });
    expect(judge(summarize([run([{ totalMs: 241_000 }])])).p95).toBe(false);
    expect(judge(summarize([run([{}, { cacheReadTokens: 0 }])])).cache).toBe(false);
    expect(judge(summarize([run([{ costUsd: 0.1 }, { costUsd: 0.1 }, { costUsd: 0.1 }, { costUsd: 0.1 }])])).cost).toBe(false);
    expect(judge(summarize([run([{ costUsd: 0.6 }, { costUsd: 0.6 }])])).cost).toBe(false);
  });
});

// ── 가짜 fetch: count_tokens는 JSON, messages는 SSE ──
const enc = new TextEncoder();
const frame = (e: { type: string; [k: string]: unknown }) => enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);

const BODY = JSON.stringify({
  safety: { flag: "none" },
  declined_topics: [],
  reading_notes: [],
  headline: "머리",
  dek: "소제",
  sections: [{ icon: "x", title: "제목", about: "group", paragraphs: [{ key: "a", text: "함께 이야기했다", evidence_ids: [] }], evidence: [] }],
});

function fakeFetch() {
  const calls = { count: 0, messages: [] as Record<string, unknown>[] };
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).includes("count_tokens")) {
      calls.count++;
      return new Response(JSON.stringify({ input_tokens: 5000 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    calls.messages.push(body);
    const first = calls.messages.length === 1;
    const events = [
      {
        type: "message_start",
        message: {
          id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 50, output_tokens: 1, cache_creation_input_tokens: first ? 4000 : 0, cache_read_input_tokens: first ? 0 : 4000 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: BODY } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1000 } },
      { type: "message_stop" },
    ];
    return new Response(
      new ReadableStream({
        start(c) {
          for (const e of events) c.enqueue(frame(e));
          c.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  return { fetch, calls };
}

const msgs: ChatMessage[] = Array.from({ length: 6 }, (_, i) => ({
  id: i,
  ts: Date.UTC(2026, 9, 1, 0, i),
  sender: i % 2 ? "P2" : "P1",
  kind: "text" as const,
  text: "안녕 오늘 뭐해",
  line: i + 1,
}));

describe("measureRun", () => {
  it("1편 스트림 시작에서 2~4편이 출발하고, 편별 수치와 validate 결과를 모은다", async () => {
    const { fetch, calls } = fakeFetch();
    const client = new Anthropic({ apiKey: "test", fetch: fetch as typeof globalThis.fetch, maxRetries: 0 });
    const payload = buildPayload({ messages: msgs, tone: "fact", concept: "group", kind: "group", tokenBudget: 10_000, tokensPerChar: 1 });
    let t = 0;
    const r = await measureRun(client, payload, { now: () => (t += 100) });

    expect(calls.count).toBe(0);
    expect(calls.messages).toHaveLength(4);
    expect(r.episodes.map((e) => e.n)).toEqual([1, 2, 3, 4]);
    expect(r.episodes.every((e) => e.status === "done" && e.kind === "ok")).toBe(true);
    expect(r.episodes[0].cacheReadTokens).toBe(0);
    expect(r.episodes.slice(1).every((e) => e.cacheReadTokens === 4000)).toBe(true);
    expect(r.episodes.every((e) => e.outputTokens === 1000 && e.ttftMs! > 0 && e.totalMs >= e.ttftMs!)).toBe(true);
    // 4000×5 + 50×4 + 1000×20 per MTok 같은 단가표 계산이 편마다 들어 있다
    expect(r.episodes[0].costUsd).toBeCloseTo((50 * 4 + 1000 * 20 + 4000 * 5) / 1e6, 10);
  });
});

describe("measureTokens", () => {
  it("system + 데이터 메시지만 countTokens로 보내고 글자 수를 함께 돌려준다", async () => {
    const { fetch, calls } = fakeFetch();
    const client = new Anthropic({ apiKey: "test", fetch: fetch as typeof globalThis.fetch, maxRetries: 0 });
    const payload = buildPayload({ messages: msgs, tone: "fact", concept: "group", kind: "group", tokenBudget: 10_000, tokensPerChar: 1 });
    const r = await measureTokens(client, payload);
    expect(calls.count).toBe(1);
    expect(r.inputTokens).toBe(5000);
    expect(r.chars).toBeGreaterThan(payload.transcript.length);
  });
});
