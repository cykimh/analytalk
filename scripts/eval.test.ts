import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { DEFAULT_EST_COST_USD, inputTokenBudgetFor } from "@/lib/config";
import { PICKABLE_TONES } from "@/lib/llm/concepts";
import { modelSettings } from "@/lib/llm/settings";
import { buildPayload, payloadIndex } from "@/lib/payload/build";
import type { ChatMessage, ParseResult } from "@/lib/parse/parse";
import { syntheticGroupChat } from "@/test/syntheticChat";
import {
  discoverGolden,
  evalCase,
  judgeEval,
  parseArgs,
  pickLimited,
  prepareCases,
  renderReview,
  scoreReport,
  summarizeEval,
  type EvalCase,
  type ReportScore,
} from "./eval";

describe("parseArgs", () => {
  it("--dir만 주면 기본값: 모델은 앱 기본, 말투는 고를 수 있는 5개 전부(v2.3: record 없음)", () => {
    expect(parseArgs(["--dir", "g"])).toEqual({ dir: "g", models: [], tones: [...PICKABLE_TONES], limit: null, dryRun: false, prod: false, yes: false });
    expect(parseArgs(["--dir", "g"]).tones).toEqual(["fact", "warm", "show", "docu", "detective"]);
    expect(parseArgs(["--dir", "g", "--tone", "docu", "--tone", "detective"]).tones).toEqual(["docu", "detective"]);
    expect(() => parseArgs(["--dir", "g", "--tone", "record"])).toThrow(/tone/);
  });
  it("옵션을 읽는다: --model·--tone은 여러 번", () => {
    expect(parseArgs(["--dir", "g", "--model", "a", "--model", "b", "--tone", "warm", "--limit", "4", "--dry-run", "--prod", "--yes"])).toEqual({
      dir: "g",
      models: ["a", "b"],
      tones: ["warm"],
      limit: 4,
      dryRun: true,
      prod: true,
      yes: true,
    });
  });
  it("--compare는 Sonnet 5.5와 Opus 5.5 둘", () => {
    expect(parseArgs(["--dir", "g", "--compare"]).models).toEqual(["claude-sonnet-5-5", "claude-opus-5-5"]);
  });
  it.each([
    [[], /--dir/],
    [["--dir"], /--dir/],
    [["--dir", "g", "--limit", "0"], /limit/],
    [["--dir", "g", "--limit", "x"], /limit/],
    [["--dir", "g", "--model"], /model/],
    [["--dir", "g", "--tone", "x"], /tone/],
    [["--dir", "g", "--compare", "--model", "a"], /compare/],
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
const payload = buildPayload({ messages: msgs, tone: "fact", concept: "group", kind: "group", tokenBudget: 10_000, tokensPerChar: 1 });
const firstId = [...payloadIndex(payload).keys()][0];

describe("prepareCases", () => {
  const big = syntheticGroupChat(40, 60);
  const parsed = { formatId: "android-ko", messages: big, participants: [...new Set(big.flatMap((m) => (m.sender ? [m.sender] : [])))], systemNames: [] } as unknown as ParseResult;
  const files = [{ path: "group/a.txt", concept: "group" as const, injection: true }];
  const models = ["claude-sonnet-5-5", "claude-opus-5-5"];

  it("파일 1 × 말투 5 × 모델 2 = 10건, 파일 → 말투 → 모델 순서", () => {
    const cases = prepareCases(files, [parsed], models, [...PICKABLE_TONES]);
    expect(cases).toHaveLength(10);
    expect(cases.map((c) => `${c.tone}/${c.model}`)).toEqual(PICKABLE_TONES.flatMap((t) => models.map((m) => `${t}/${m}`)));
    expect(cases.every((c) => c.label === "group-1-injection" && c.concept === "group" && c.injection)).toBe(true);
    expect(cases.every((c, i) => c.payload.tone === cases[i].tone)).toBe(true);
  });
  it("페이로드는 모델 예산마다 따로 만든다: Sonnet이 Opus보다 많이 보낸다", () => {
    const cases = prepareCases(files, [parsed], models, ["fact"]);
    const [sonnet, opus] = cases;
    expect(inputTokenBudgetFor(sonnet.model)).toBeGreaterThan(inputTokenBudgetFor(opus.model));
    expect(sonnet.payload.msgSent).toBeGreaterThanOrEqual(opus.payload.msgSent);
    expect(sonnet.payload.msgSent).toBeGreaterThan(opus.payload.msgSent);
  });
  it("형식을 모르는 파일은 던진다", () => {
    expect(() => prepareCases(files, [{ ...parsed, formatId: null }], models, ["fact"])).toThrow(/형식/);
  });
});

/** 문단 3개(둘은 nag_open, 하나는 '~것 같다' 금지 표현), 근거 2개(하나는 본문에 없는 인용) */
const body = (headline = "머리") =>
  JSON.stringify({
    safety: { flag: "none" },
    declined_topics: [],
    reading_notes: [],
    headline,
    dek: "소제",
    sections: [
      {
        part: "nag_open",
        icon: "x",
        title: "제목",
        about: "group",
        paragraphs: [
          { key: "a", text: "함께 이야기했다", evidence_ids: ["e1"] },
          { key: "b", text: "그는 게이가 분명하다", evidence_ids: [] },
        ],
        evidence: [
          { id: "e1", msg_id: firstId, quote: "안녕" },
          { id: "e2", msg_id: firstId, quote: "없는 말" },
        ],
      },
      {
        part: "nag_room",
        icon: "y",
        title: "리듬",
        about: "group",
        paragraphs: [{ key: "a", text: "저녁마다 이야기했다", evidence_ids: ["e1"] }],
        evidence: [{ id: "e1", msg_id: firstId, quote: "안녕" }],
      },
    ],
  });

const stats = payload.stats;
const idx = payloadIndex(payload);

describe("scoreReport", () => {
  it("문단 삭제율·구성별 삭제·인용 일치·금지 표현 수를 센다", () => {
    const { score } = scoreReport(body(), "ok", idx, stats, payload);
    expect(score).toMatchObject({
      status: "partial",
      paragraphsIn: 3,
      paragraphsDropped: 1,
      evidenceIn: 3,
      evidenceMatched: 2,
      bannedHits: 1,
      dropByPart: { nag_open: { in: 2, dropped: 1 }, nag_room: { in: 1, dropped: 0 } },
      // v2.4: 지운 까닭(금지 표현 1문단, 원문과 안 맞는 근거 1개)
      dropReasons: { banned: 1, evidence_unmatched: 1 },
      relinked: 0,
    });
    expect(score.dropRate).toBeCloseTo(1 / 3, 10);
  });
  it("제목·소제·섹션 제목의 금지 표현도 센다", () => {
    expect(scoreReport(body("그는 게이가 분명하다"), "ok", idx, stats, payload).score.bannedHits).toBe(2);
  });
  it("JSON이 아니면 failed, 센 것은 0", () => {
    const { score, content } = scoreReport("not json", "ok", idx, stats, payload);
    expect(content).toBeNull();
    expect(score).toMatchObject({ status: "failed", paragraphsIn: 0, dropRate: 0, evidenceIn: 0, bannedHits: 0, dropByPart: {} });
  });
});

const score = (over: Partial<ReportScore> = {}): ReportScore => ({
  label: "group-1",
  tone: "fact",
  model: "claude-sonnet-5-5",
  servedModel: "claude-sonnet-5-5",
  fallback: false,
  status: "done",
  kind: "ok",
  totalMs: 100_000,
  costUsd: DEFAULT_EST_COST_USD,
  paragraphsIn: 10,
  paragraphsDropped: 1,
  dropRate: 0.1,
  dropByPart: { chronicle: { in: 10, dropped: 1 } },
  dropReasons: { banned: 1 },
  relinked: 0,
  evidenceIn: 8,
  evidenceMatched: 8,
  bannedHits: 0,
  msgSent: 1000,
  ...over,
});

describe("summarizeEval / judgeEval", () => {
  it("모델별·모델×말투별로 원가 평균, 인용 일치율, 금지 수, 270초 초과 수, 구성별 삭제율을 모은다", () => {
    const opus = { model: "claude-opus-5-5", servedModel: "claude-opus-5-5" };
    const s = summarizeEval([
      score(),
      score({ tone: "warm", paragraphsDropped: 5, dropByPart: { chronicle: { in: 10, dropped: 5 } }, bannedHits: 2, evidenceMatched: 6 }),
      score({ ...opus, totalMs: 271_000, costUsd: 2 }),
    ]);
    expect(Object.keys(s.byModel).sort()).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
    const sonnet = s.byModel["claude-sonnet-5-5"];
    expect(sonnet).toMatchObject({ cases: 2, bannedHits: 2, overDeadline: 0, droppedParagraphs: 6, fallbacks: 0 });
    expect(sonnet.quoteMatchRate).toBeCloseTo(14 / 16, 10);
    expect(sonnet.costUsdAvg).toBeCloseTo(DEFAULT_EST_COST_USD, 10);
    expect(sonnet.dropRateByPart).toEqual({ chronicle: 6 / 20 });
    expect(s.byModel["claude-opus-5-5"]).toMatchObject({ cases: 1, overDeadline: 1, costUsdAvg: 2 });
    expect(Object.keys(s.byModelTone["claude-sonnet-5-5"]).sort()).toEqual(["fact", "warm"]);
    expect(s.byModelTone["claude-sonnet-5-5"].warm).toMatchObject({ cases: 1, bannedHits: 2 });
  });
  it("통과 기준: 인용 100%, 금지 0, 270초 초과 0, fallback 0, 평균 원가 추정 × 1.3 이하. 검수는 사람이 본다", () => {
    const j = (over: Partial<ReportScore>[]) => judgeEval(summarizeEval(over.map((o) => score(o))).byModel["claude-sonnet-5-5"]);
    expect(j([{}])).toEqual({ quote: true, banned: true, deadline: true, cost: true, fallback: true, pass: true, review: "manual" });
    expect(j([{ evidenceMatched: 7 }]).quote).toBe(false);
    expect(j([{ bannedHits: 1 }]).banned).toBe(false);
    expect(j([{ totalMs: 270_000 }]).deadline).toBe(false);
    expect(j([{ costUsd: DEFAULT_EST_COST_USD * 1.31 }]).cost).toBe(false);
    expect(j([{ costUsd: DEFAULT_EST_COST_USD * 1.3 }]).cost).toBe(true);
    expect(j([{ status: "failed" }]).pass).toBe(false);
  });
  it("fallback이 있으면 통과하지 못한다", () => {
    const s = summarizeEval([score({ fallback: true, servedModel: "claude-opus-5-5" })]).byModel["claude-sonnet-5-5"];
    expect(s.fallbacks).toBe(1);
    expect(judgeEval(s)).toMatchObject({ fallback: false, pass: false });
  });
  it("마감에 끊긴 회차(kind partial)는 총 시간이 270초 아래여도 초과로 센다", () => {
    const s = summarizeEval([score({ kind: "partial", status: "partial", totalMs: 269_900 })]).byModel["claude-sonnet-5-5"];
    expect(s.overDeadline).toBe(1);
    expect(judgeEval(s).deadline).toBe(false);
  });
  it("kind가 ok가 아닌 회차는 건진 JSON이 검증을 통과해도 통과를 막는다", () => {
    for (const kind of ["truncated", "error", "refused", "partial"]) {
      const s = summarizeEval([score({ kind, status: "done" })]).byModel["claude-sonnet-5-5"];
      expect(s.notOk).toBe(1);
      expect(judgeEval(s).pass).toBe(false);
    }
  });
});

// ── 가짜 fetch ──
const enc = new TextEncoder();
const frame = (e: { type: string; [k: string]: unknown }) => enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);

function fakeFetch(servedModel = "claude-opus-5-5") {
  const calls: Record<string, unknown>[] = [];
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    const events = [
      {
        type: "message_start",
        message: {
          id: "m", type: "message", role: "assistant", model: servedModel, content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 5000, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
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

const theCase = (model: string): EvalCase => ({ label: "group-1", concept: "group", injection: false, tone: "warm", model, payload });

describe("evalCase", () => {
  it("케이스 모델·출력 상한으로 요청하고, 점수·검수용 본문·원장 한 항목을 돌려준다", async () => {
    const { fetch, calls } = fakeFetch("claude-sonnet-5-5");
    const client = new Anthropic({ apiKey: "test", fetch: fetch as typeof globalThis.fetch, maxRetries: 0 });
    let t = 0;
    const r = await evalCase(client, theCase("claude-sonnet-5-5"), { now: () => (t += 100) });
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe("claude-sonnet-5-5");
    expect(calls[0].max_tokens).toBe(modelSettings({ ANTHROPIC_MODEL: "claude-sonnet-5-5" }).maxTokens);
    expect(r.score).toMatchObject({
      label: "group-1", tone: "warm", model: "claude-sonnet-5-5", servedModel: "claude-sonnet-5-5", fallback: false,
      status: "partial", kind: "ok", bannedHits: 1, msgSent: payload.msgSent,
    });
    expect(r.score.totalMs).toBeGreaterThan(0);
    expect(r.score.costUsd).toBeCloseTo((5000 * 2 + 1000 * 10) / 1e6, 10);
    expect(r.ledger).toHaveLength(1);
    expect(r.ledger[0]).toMatchObject({ model: "claude-sonnet-5-5", usage: { input_tokens: 5000, output_tokens: 1000 } });
    expect(r.content?.sections).toHaveLength(2);
  });
  it("응답 모델이 케이스 모델과 다르면 fallback", async () => {
    const { fetch } = fakeFetch("claude-sonnet-5");
    const client = new Anthropic({ apiKey: "test", fetch: fetch as typeof globalThis.fetch, maxRetries: 0 });
    const r = await evalCase(client, theCase("claude-sonnet-5-5"));
    expect(r.score).toMatchObject({ fallback: true, servedModel: "claude-sonnet-5" });
  });
});

describe("renderReview", () => {
  it("파일·말투별로 두 모델 본문을 나란히, 자리표시자를 채우고 품질 메모 칸을 둔다", () => {
    const content = (text: string) => ({
      safety: { flag: "none" as const },
      declined_topics: [],
      reading_notes: [],
      headline: "머리",
      dek: "소제",
      sections: [{ part: "chronicle", icon: "x", title: "제목", about: "group", paragraphs: [{ key: "a", text, evidence_ids: [] }], evidence: [] }],
    });
    const md = renderReview([
      { label: "group-1", tone: "fact", model: "claude-sonnet-5-5", content: content("총 {{stat:total}}개"), stats },
      { label: "group-1", tone: "fact", model: "claude-opus-5-5", content: null, stats },
    ]);
    expect(md).toContain("group-1");
    expect(md).toContain("claude-sonnet-5-5");
    expect(md).toContain("총 6개");
    expect(md).not.toContain("{{stat");
    expect(md).toMatch(/품질 메모/);
    expect(md).toMatch(/본문 없음/);
  });
});
