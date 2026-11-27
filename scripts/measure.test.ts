import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { DEFAULT_EST_COST_USD, DEFAULT_MODEL, inputTokenBudgetFor, PROMPT_RESERVE_TOKENS, TOKENS_PER_CHAR } from "@/lib/config";
import { modelSettings } from "@/lib/llm/settings";
import { buildPayload, payloadTokens } from "@/lib/payload/build";
import type { ChatMessage } from "@/lib/parse/parse";
import { syntheticGroupChat } from "@/test/syntheticChat";
import {
  displayNames,
  namedMessages,
  judge,
  measurePayload,
  measureReport,
  measureTokens,
  parseArgs,
  percentile,
  rateLimitsFrom,
  recommendBudget,
  summarize,
  type ReportMeasure,
} from "./measure";

describe("parseArgs", () => {
  it("파일만 주면 기본값: group, fact, 1회, 실제 실행", () => {
    expect(parseArgs(["a.txt"])).toEqual({
      file: "a.txt",
      concept: "group",
      tone: "fact",
      model: null,
      budget: null,
      runs: 1,
      mode: "run",
      dryRun: false,
      prod: false,
      yes: false,
    });
  });
  it("옵션을 읽는다", () => {
    expect(
      parseArgs(["a.txt", "--concept", "couple", "--tone", "show", "--model", "claude-opus-5-5", "--budget", "100000", "--runs", "2", "--check-limits", "--dry-run", "--prod", "--yes"]),
    ).toEqual({
      file: "a.txt",
      concept: "couple",
      tone: "show",
      model: "claude-opus-5-5",
      budget: 100_000,
      runs: 2,
      mode: "limits",
      dryRun: true,
      prod: true,
      yes: true,
    });
    expect(parseArgs(["a.txt", "--count-only"]).mode).toBe("count");
    for (const tone of ["warm", "docu", "detective"]) expect(parseArgs(["a.txt", "--tone", tone]).tone).toBe(tone);
    // v2.3: record는 담임 선생님(warm)으로 합쳐 고를 수 없다
    expect(() => parseArgs(["a.txt", "--tone", "record"])).toThrow(/tone/);
  });
  it.each([
    [[], /샘플 파일/],
    [["a.txt", "--concept", "work"], /concept/],
    [["a.txt", "--tone", "x"], /tone/],
    [["a.txt", "--model"], /model/],
    [["a.txt", "--budget", "0"], /budget/],
    [["a.txt", "--runs", "0"], /runs/],
    [["a.txt", "--runs", "x"], /runs/],
    [["a.txt", "--count-only", "--check-limits"], /동시에/],
    [["a.txt", "--bogus"], /알 수 없는/],
    [["a.txt", "b.txt"], /하나/],
  ])("잘못된 인자 %j 는 던진다", (argv, msg) => {
    expect(() => parseArgs(argv as string[])).toThrow(msg);
  });
});

describe("displayNames", () => {
  it("발신자에게 앱의 기본 이름(금지 글자 정리, 성을 뺀 이름)을 주고 봇·알 수 없음은 뺀다", () => {
    expect(displayNames({ participants: ["철수", "영희.", "a|b", "", "김민지", "(알 수 없음)", "오픈채팅봇"] })).toEqual({
      철수: "철수",
      "영희.": "영희",
      "a|b": "ab",
      김민지: "민지",
    });
  });
});

describe("namedMessages", () => {
  it("앱과 같이 봇·위험 신호 메시지를 빼고 발신자를 표시 이름으로 바꾼다", () => {
    const at = (id: number) => Date.UTC(2026, 0, 1) + id * 60_000;
    const messages = [
      { id: 0, ts: at(0), sender: "김민지", kind: "text" as const, text: "안녕", line: 1 },
      { id: 1, ts: at(1), sender: "오픈채팅봇", kind: "text" as const, text: "공지", line: 2 },
      { id: 2, ts: at(2), sender: "철수", kind: "text" as const, text: "어제 자해 했어", line: 3 },
      { id: 3, ts: at(3), sender: "철수", kind: "text" as const, text: "응", line: 4 },
    ];
    expect(namedMessages({ participants: ["김민지", "오픈채팅봇", "철수"], messages }).map((m) => [m.id, m.sender])).toEqual([
      [0, "민지"],
      [3, "철수"],
    ]);
  });
});

describe("measurePayload", () => {
  const messages = syntheticGroupChat(40, 60);

  it("통계 요약과 프롬프트 몫까지 모델 입력 예산 안에 들고, 말투가 실린다", () => {
    const s = modelSettings({});
    const p = measurePayload(messages, "group", "warm", s);
    expect(payloadTokens(p, TOKENS_PER_CHAR).total + PROMPT_RESERVE_TOKENS).toBeLessThanOrEqual(inputTokenBudgetFor(DEFAULT_MODEL));
    expect(p.msgSent).toBeGreaterThan(0);
    expect(p).toMatchObject({ v: 2, tone: "warm", concept: "group", kind: "group" });
  });

  it("couple 컨셉은 kind pair", () => {
    expect(measurePayload(messages, "couple", "fact", modelSettings({}))).toMatchObject({ concept: "couple", kind: "pair" });
  });
});

describe("percentile", () => {
  it("올림 순위(nearest-rank)", () => {
    expect(percentile([10, 20, 30, 40], 0.95)).toBe(40);
    expect(percentile([5], 0.95)).toBe(5);
    expect(percentile([], 0.95)).toBe(0);
  });
});

const rep = (over: Partial<ReportMeasure> = {}): ReportMeasure => ({
  ttftMs: 2000,
  totalMs: 100_000,
  inputTokens: 300_000,
  outputTokens: 20_000,
  thinkingTokens: null,
  costUsd: DEFAULT_EST_COST_USD,
  requestedModel: "claude-sonnet-5-5",
  servedModel: "claude-sonnet-5-5",
  fallback: false,
  stopCategory: null,
  status: "done",
  kind: "ok",
  ...over,
});

describe("summarize / judge", () => {
  it("평균 원가·p95·fallback 수·ok 아닌 회차 수를 모은다", () => {
    const s = summarize([rep({ costUsd: 1 }), rep({ costUsd: 1.4, totalMs: 230_000 }), rep({ fallback: true, kind: "error" })]);
    expect(s).toMatchObject({ runs: 3, p95TotalMs: 230_000, fallbacks: 1, notOk: 1 });
    expect(s.costUsdAvg).toBeCloseTo((1 + 1.4 + DEFAULT_EST_COST_USD) / 3, 10);
  });
  it("통과 기준: p95 240초 이하, 평균 원가 추정 ±30%, fallback 0, ok 아닌 회차 0", () => {
    expect(judge(summarize([rep()]))).toEqual({ p95: true, cost: true, fallback: true, ok: true, pass: true });
    expect(judge(summarize([rep({ costUsd: 1.7 })])).cost).toBe(false);
    expect(judge(summarize([rep({ costUsd: 0.8 })])).cost).toBe(false);
    expect(judge(summarize([rep({ fallback: true })])).pass).toBe(false);
    expect(judge(summarize([rep({ totalMs: 240_001 })])).p95).toBe(false);
    expect(judge(summarize([rep({ kind: "partial" })])).ok).toBe(false);
  });
});

describe("rateLimitsFrom / recommendBudget", () => {
  it("헤더가 없으면 전부 null", () => {
    expect(rateLimitsFrom(new Headers())).toEqual({ inputTokensPerMin: null, outputTokensPerMin: null, requestsPerMin: null });
  });
  it("한도 헤더를 읽는다", () => {
    const h = new Headers({
      "anthropic-ratelimit-input-tokens-limit": "450000",
      "anthropic-ratelimit-output-tokens-limit": "90000",
      "anthropic-ratelimit-requests-limit": "1000",
    });
    expect(rateLimitsFrom(h)).toEqual({ inputTokensPerMin: 450_000, outputTokensPerMin: 90_000, requestsPerMin: 1000 });
  });
  it("ITPM이 예산 × 1.05보다 작을 때만 floor(ITPM × 0.9)를 권한다", () => {
    expect(recommendBudget(300_000, 400_000)).toBe(270_000);
    expect(recommendBudget(420_000, 400_000)).toBeNull();
    expect(recommendBudget(null, 400_000)).toBeNull();
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
  sections: [{ part: "chronicle", icon: "x", title: "제목", about: "group", paragraphs: [{ key: "a", text: "함께 이야기했다", evidence_ids: [] }], evidence: [] }],
});

function fakeFetch(countTokens: number[] = [1000, 200]) {
  const calls = { count: [] as Record<string, unknown>[], messages: [] as Record<string, unknown>[] };
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).includes("count_tokens")) {
      calls.count.push(body);
      return new Response(JSON.stringify({ input_tokens: countTokens[calls.count.length - 1] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    calls.messages.push(body);
    const events = [
      {
        type: "message_start",
        message: {
          id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 5000, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
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

const clientOf = (fetch: unknown) => new Anthropic({ apiKey: "test", fetch: fetch as typeof globalThis.fetch, maxRetries: 0 });

const msgs: ChatMessage[] = Array.from({ length: 6 }, (_, i) => ({
  id: i,
  ts: Date.UTC(2026, 9, 1, 0, i),
  sender: i % 2 ? "P2" : "P1",
  kind: "text" as const,
  text: "안녕 오늘 뭐해",
  line: i + 1,
}));
const payload = buildPayload({ messages: msgs, tone: "fact", concept: "group", kind: "group", tokenBudget: 10_000, tokensPerChar: 1 });

describe("measureTokens", () => {
  it("countTokens를 두 번(전체, 대화 본문을 비운 것) 부르고 글자당 토큰·고정 몫을 계산한다", async () => {
    const { fetch, calls } = fakeFetch([1000, 200]);
    const p = { ...payload, anchors: "", transcript: "Q".repeat(1000) };
    const s = modelSettings({ ANTHROPIC_MODEL: "claude-opus-5-5" });
    const r = await measureTokens(clientOf(fetch), p, s);
    expect(calls.count).toHaveLength(2);
    expect(JSON.stringify(calls.count[0])).toContain("Q".repeat(1000));
    expect(JSON.stringify(calls.count[1])).not.toContain("QQQQ");
    // 서버 countInputTokens와 같은 5필드
    expect(Object.keys(calls.count[0]).sort()).toEqual(["messages", "model", "output_config", "system", "thinking"]);
    expect(r).toMatchObject({ model: "claude-opus-5-5", fullTokens: 1000, overheadTokens: 200, dataChars: 1000, tokensPerChar: 0.8 });
    const statsLegend = payloadTokens(p, 0.8).total - payloadTokens(p, 0.8).text;
    expect(r.reserveTokens).toBeCloseTo(200 - statsLegend, 6);
  });
});

describe("measureReport", () => {
  it("스트림을 한 번 열고, 응답 모델이 요청과 다르면 fallback", async () => {
    const { fetch, calls } = fakeFetch();
    let t = 0;
    const r = await measureReport(clientOf(fetch), payload, modelSettings({ ANTHROPIC_MODEL: "claude-sonnet-5-5" }), { now: () => (t += 100) });
    expect(calls.messages).toHaveLength(1);
    expect(calls.count).toHaveLength(0);
    expect(calls.messages[0].model).toBe("claude-sonnet-5-5");
    expect(r).toMatchObject({ requestedModel: "claude-sonnet-5-5", servedModel: "claude-opus-5-5", fallback: true, status: "done", kind: "ok", outputTokens: 1000, inputTokens: 5000 });
    expect(r.ttftMs).toBeGreaterThan(0);
    expect(r.totalMs).toBeGreaterThanOrEqual(r.ttftMs!);
    expect(r.costUsd).toBeCloseTo((5000 * 4 + 1000 * 20) / 1e6, 10);
  });
  it("요청한 모델이 그대로 답하면 fallback이 아니다", async () => {
    const { fetch } = fakeFetch();
    const r = await measureReport(clientOf(fetch), payload, modelSettings({ ANTHROPIC_MODEL: "claude-opus-5-5" }));
    expect(r.fallback).toBe(false);
  });
});
