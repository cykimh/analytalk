import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { buildPayload, payloadIndex } from "@/lib/payload/build";
import type { ChatMessage } from "@/lib/parse/parse";
import {
  discoverGolden,
  pickLimited,
  evalPayload,
  judgeEval,
  parseArgs,
  recordEvalUsage,
  scoreEpisode,
  summarizeEval,
  type EpisodeScore,
  type FileEval,
} from "./eval";

describe("parseArgs", () => {
  it("--dir만 주면 기본값", () => {
    expect(parseArgs(["--dir", "g"])).toEqual({ dir: "g", model: null, limit: null, dryRun: false });
  });
  it("옵션을 읽는다", () => {
    expect(parseArgs(["--dir", "g", "--model", "claude-sonnet-5-5", "--limit", "4", "--dry-run"])).toEqual({
      dir: "g",
      model: "claude-sonnet-5-5",
      limit: 4,
      dryRun: true,
    });
  });
  it.each([
    [[], /--dir/],
    [["--dir"], /--dir/],
    [["--dir", "g", "--limit", "0"], /limit/],
    [["--dir", "g", "--limit", "x"], /limit/],
    [["--dir", "g", "--model"], /model/],
    [["--dir", "g", "--bogus"], /알 수 없는/],
    [["--dir", "g", "extra"], /위치 인자/],
  ])("잘못된 인자 %j 는 던진다", (argv, msg) => {
    expect(() => parseArgs(argv as string[])).toThrow(msg);
  });
});

describe("discoverGolden", () => {
  it("하위 폴더(group·couple)나 파일명 접두로 컨셉을 정하고, injection 표시를 단다", () => {
    const r = discoverGolden(["group/a.txt", "couple/b.csv", "group-c.txt", "couple-injection-d.zip", "group/injection-e.txt"]);
    expect(r).toEqual([
      { path: "group/a.txt", concept: "group", injection: false },
      { path: "couple/b.csv", concept: "couple", injection: false },
      { path: "group-c.txt", concept: "group", injection: false },
      { path: "couple-injection-d.zip", concept: "couple", injection: true },
      { path: "group/injection-e.txt", concept: "group", injection: true },
    ]);
  });
  it("컨셉을 알 수 없는 파일, 지원하지 않는 확장자, 숨김 파일은 건너뛴다", () => {
    expect(discoverGolden(["x.txt", "group/.DS_Store", "group/a.md", "group/ok.txt"]).map((f) => f.path)).toEqual(["group/ok.txt"]);
  });
});

describe("pickLimited", () => {
  const f = (path: string, concept: "group" | "couple") => ({ path, concept, injection: false });
  const all = [f("g1", "group"), f("g2", "group"), f("g3", "group"), f("c1", "couple"), f("c2", "couple")];
  it("limit이 없으면 전부", () => expect(pickLimited(all, null)).toEqual(all));
  it("컨셉을 번갈아 가며 앞에서부터 고른다", () => {
    expect(pickLimited(all, 4).map((x) => x.path)).toEqual(["g1", "c1", "g2", "c2"]);
    expect(pickLimited(all, 10)).toHaveLength(5);
  });
});

const msgs: ChatMessage[] = Array.from({ length: 6 }, (_, i) => ({
  id: i,
  ts: Date.UTC(2026, 9, 1, 0, i),
  sender: i % 2 ? "P2" : "P1",
  kind: "text" as const,
  text: "안녕 오늘 뭐해",
  line: i + 1,
}));
const payload = buildPayload({ messages: msgs, me: "P1", concept: "group", kind: "group", tokenBudget: 10_000, tokensPerChar: 1 });
const firstId = [...payloadIndex(payload).keys()][0];

/** 문단 2개(하나는 '~것 같다' 금지 표현), 근거 2개(하나는 본문에 없는 인용) */
const body = (headline = "머리") =>
  JSON.stringify({
    episode: 1,
    safety: { flag: "none" },
    declined_topics: [],
    reading_notes: [],
    headline,
    dek: "소제",
    sections: [
      {
        icon: "x",
        title: "제목",
        about: "group",
        paragraphs: [
          { key: "a", text: "함께 이야기했다", evidence_ids: ["e1"] },
          { key: "b", text: "그는 좋아하는 것 같다", evidence_ids: [] },
        ],
        evidence: [
          { id: "e1", msg_id: firstId, quote: "안녕" },
          { id: "e2", msg_id: firstId, quote: "없는 말" },
        ],
      },
    ],
    next_teaser: null,
  });

const stats = payload.stats;
const idx = payloadIndex(payload);

describe("scoreEpisode", () => {
  it("문단 삭제율·인용 일치·금지 표현 수를 센다", () => {
    const s = scoreEpisode(1, body(), "ok", idx, stats);
    expect(s).toMatchObject({
      n: 1,
      status: "partial",
      paragraphsIn: 2,
      paragraphsDropped: 1,
      dropRate: 0.5,
      evidenceIn: 2,
      evidenceMatched: 1,
      bannedHits: 1,
    });
  });
  it("제목·소제·섹션 제목의 금지 표현도 센다", () => {
    expect(scoreEpisode(1, body("그는 좋아하는 것 같다"), "ok", idx, stats).bannedHits).toBe(2);
  });
  it("JSON이 아니면 failed, 센 것은 0", () => {
    expect(scoreEpisode(2, "not json", "ok", idx, stats)).toMatchObject({
      status: "failed",
      paragraphsIn: 0,
      dropRate: 0,
      evidenceIn: 0,
      bannedHits: 0,
    });
  });
});

const score = (over: Partial<EpisodeScore> = {}): EpisodeScore => ({
  n: 1,
  status: "done",
  kind: "ok",
  totalMs: 100_000,
  costUsd: 0.3,
  paragraphsIn: 10,
  paragraphsDropped: 1,
  dropRate: 0.1,
  evidenceIn: 8,
  evidenceMatched: 8,
  bannedHits: 0,
  ...over,
});
const file = (over: Partial<EpisodeScore>[] = []): FileEval => ({
  label: "group-1",
  concept: "group",
  injection: false,
  episodes: [1, 2, 3, 4].map((n, i) => score({ n, ...over[i] })),
});

describe("summarizeEval / judgeEval", () => {
  it("원가 합·평균, 인용 일치율, 금지 수, 270초 초과 수, 편별 문단 삭제율을 모은다", () => {
    const s = summarizeEval([
      file(),
      file([{ paragraphsDropped: 5, dropRate: 0.5, paragraphsIn: 10 }, { bannedHits: 2 }, { totalMs: 271_000 }, { evidenceMatched: 6 }]),
    ]);
    expect(s.files).toBe(2);
    expect(s.costUsdTotal).toBeCloseTo(2.4, 10);
    expect(s.costUsdAvgPerFile).toBeCloseTo(1.2, 10);
    expect(s.bannedHits).toBe(2);
    expect(s.overDeadline).toBe(1);
    expect(s.quoteMatchRate).toBeCloseTo(62 / 64, 10);
    expect(s.droppedParagraphs).toBe(12);
    // 편별 삭제율은 (지운 문단 합 / 전체 문단 합)
    expect(s.dropRateByEpisode).toEqual([6 / 20, 2 / 20, 2 / 20, 2 / 20]);
  });
  it("통과 기준: 인용 100%, 금지 0, 270초 초과 0, 평균 $1.60 이하. 검수 평균은 사람이 본다", () => {
    expect(judgeEval(summarizeEval([file()]))).toEqual({ quote: true, banned: true, deadline: true, cost: true, pass: true, review: "manual" });
    expect(judgeEval(summarizeEval([file([{ evidenceMatched: 7 }])])).quote).toBe(false);
    expect(judgeEval(summarizeEval([file([{ bannedHits: 1 }])])).banned).toBe(false);
    expect(judgeEval(summarizeEval([file([{ totalMs: 270_001 }])])).deadline).toBe(false);
    expect(judgeEval(summarizeEval([file([{ costUsd: 0.5 }, { costUsd: 0.5 }, { costUsd: 0.5 }, { costUsd: 0.5 }])])).cost).toBe(false);
    expect(judgeEval(summarizeEval([file([{ status: "failed" }])])).pass).toBe(false);
  });
  it("마감에 끊긴 편(kind partial)은 총 시간이 270초 아래여도 초과로 센다", () => {
    const s = summarizeEval([file([{ kind: "partial", status: "partial", totalMs: 269_900 }])]);
    expect(s.overDeadline).toBe(1);
    expect(judgeEval(s).deadline).toBe(false);
    expect(judgeEval(s).pass).toBe(false);
    expect(judgeEval(summarizeEval([file([{ totalMs: 270_000 }])])).deadline).toBe(false);
  });
  it("kind가 ok가 아닌 편은 건진 JSON이 검증을 통과해도 통과를 막는다", () => {
    for (const kind of ["truncated", "error", "refused", "partial"]) {
      const s = summarizeEval([file([{ kind, status: "done" }])]);
      expect(s.notOkEpisodes).toBe(1);
      expect(judgeEval(s).pass).toBe(false);
    }
    expect(summarizeEval([file()]).notOkEpisodes).toBe(0);
  });
  it("파일이 없으면 통과하지 않는다", () => {
    expect(judgeEval(summarizeEval([])).pass).toBe(false);
  });
});

// ── 가짜 fetch ──
const enc = new TextEncoder();
const frame = (e: { type: string; [k: string]: unknown }) => enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);

function fakeFetch() {
  const calls: Record<string, unknown>[] = [];
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    const events = [
      {
        type: "message_start",
        message: {
          id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 50, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 4000 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: body() } },
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

describe("evalPayload", () => {
  it("4편을 실행해 편별 점수를 모으고, --model이면 요청 모델을 바꾼다", async () => {
    const { fetch, calls } = fakeFetch();
    const client = new Anthropic({ apiKey: "test", fetch: fetch as typeof globalThis.fetch, maxRetries: 0 });
    let t = 0;
    const r = await evalPayload(client, payload, { model: "claude-sonnet-5-5", now: () => (t += 100) });
    expect(calls).toHaveLength(4);
    expect(calls.every((c) => c.model === "claude-sonnet-5-5")).toBe(true);
    expect(r.episodes.map((e) => e.n)).toEqual([1, 2, 3, 4]);
    expect(r.episodes.every((e) => e.status === "partial" && e.bannedHits === 1 && e.dropRate === 0.5)).toBe(true);
    expect(r.episodes.every((e) => e.costUsd > 0 && e.totalMs > 0)).toBe(true);
    expect(r.ledger).toHaveLength(4);
    expect(r.ledger.reduce((s, l) => s + l.usage.output_tokens, 0)).toBe(4000);
    expect(r.ledger.reduce((s, l) => s + l.usage.cache_read_input_tokens, 0)).toBe(16_000);
    expect(r.ledger.every((l) => l.model === "claude-opus-5-5")).toBe(true);
    // 검수용 본문(검증을 통과한 것)이 함께 온다
    expect(r.contents).toHaveLength(4);
    expect(r.contents[0]?.sections[0].paragraphs).toHaveLength(1);
  });
});

describe("recordEvalUsage", () => {
  it("모델별로 사용량·원가를 합쳐 record_script_usage를 한 번씩 부른다", async () => {
    const rpc = vi.fn(async () => ({ error: null }));
    const u = (o: number) => ({ input_tokens: 10, output_tokens: o, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 });
    await recordEvalUsage({ rpc }, [
      { model: "claude-opus-5-5", usage: u(100), costUsd: 0.5 },
      { model: "claude-opus-5-5", usage: u(200), costUsd: 0.25 },
    ]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("record_script_usage", {
      p_model: "claude-opus-5-5",
      p_usage: { input_tokens: 20, output_tokens: 300, cache_creation_input_tokens: 2, cache_read_input_tokens: 4 },
      p_cost: 0.75,
    });
  });
  it("rpc 오류는 던진다", async () => {
    await expect(recordEvalUsage({ rpc: async () => ({ error: { message: "x" } }) }, [{ model: "m", usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, costUsd: 1 }])).rejects.toThrow(/원장/);
  });
});
