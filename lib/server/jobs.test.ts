import { afterEach, describe, expect, it, vi } from "vitest";
import { CYCLE_ANCHOR_DAY, NOTES_FLUSH_MS } from "@/lib/config";
import { hashCode } from "@/lib/invite/code";
import { estimateCostUsd } from "@/lib/llm/cost";
import { PROMPT_VERSION } from "@/lib/llm/prompt";
import type { StoredReport } from "@/lib/llm/schema";
import { memberCodes, type Payload, payloadIndex } from "@/lib/payload/build";
import { sha256Hex } from "@/lib/payload/hash";
import {
  blockStop,
  CACHE_READ,
  CODE,
  cut,
  cutInSecondSection,
  delta,
  GROUP_NAMES,
  harness,
  instructionOf,
  longReportJson,
  makeGroupPayload,
  makePayload,
  messageDelta,
  messageStart,
  messageStop,
  partsOf,
  type Reply,
  type ReplyFn,
  reportJson,
  sseError,
  stageJson,
  staged,
  stageReply,
  textStart,
  until,
  whole,
} from "@/test/generation";
import { nextCycleStart, runReportJob } from "./jobs";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** 대화 하나를 만들어 두고 runReportJob을 직접 부른다. reply는 payload를 받아 만든다(몫을 지시로 가린다) */
async function setup(reply: (payload: Payload) => ReplyFn, o: Parameters<typeof harness>[0] & { payload?: Payload } = {}) {
  const payload = o.payload ?? makePayload();
  const h = await harness({ ...o, reply: reply(payload) });
  const invite = await h.repo.findInvite(hashCode(CODE));
  const payloadSha256 = await sha256Hex(JSON.stringify(payload));
  const claim = await h.repo.claim({
    inviteId: invite!.id,
    concept: payload.concept,
    payloadSha256,
    meta: { prompt_version: PROMPT_VERSION, tone: payload.tone, kind: payload.kind, display_names: payload.members, stats: payload.stats },
    estCost: 1.8,
  });
  const id = claim.id!;
  const report = async () => (await h.repo.getConversation(id))!.report;
  const content = async () => (await report()).content as StoredReport;
  const run = async (deps = h.deps) => {
    expect(await h.repo.startReport(id)).toBe(true);
    await runReportJob(deps, { id, payload });
    await h.settle();
  };
  const finish = vi.spyOn(h.repo, "finishReport");
  const setPaused = vi.spyOn(h.repo, "setPaused");
  const partOf = partsOf(payload);
  /** 지금까지 보낸 요청의 몫(보낸 순서) */
  const sent = () => h.streams.map((x) => partOf(x.body));
  return { h, payload, payloadSha256, id, report, content, run, finish, setPaused, sent };
}

const lastFinish = (finish: { mock: { calls: unknown[][] } }) => finish.mock.calls.at(-1)?.[0] as Record<string, unknown>;
const ONE = { input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const times = (n: number) => ({ input_tokens: 100 * n, output_tokens: 200 * n, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
/** ①과 캐시를 읽은 later개(기본 응답)의 usage 합 */
const withReads = (later: number) => ({ ...times(1 + later), cache_read_input_tokens: CACHE_READ * later });
const READ_ONE = { ...ONE, cache_read_input_tokens: CACHE_READ };
const rateLimited = (headers: Record<string, string>): Reply => ({ status: 429, error: { type: "rate_limit_error", message: "rate limited" }, headers });
const failsAfter = (text: string): Reply => ({ steps: [messageStart(), textStart, delta(text), sseError("overloaded_error")] });
const http = (status: number, type: string, extra: object = {}): Reply => ({ status, error: { type, message: type, ...extra } });
const parts = (c: StoredReport) => c.sections.map((s) => s.part);

describe("runReportJob (v2.5 나눠 쓰기: ① 인트로 → ② 개인별 → ③ 마무리)", () => {
  it("ok → done. 세 몫을 ①→②→③ 순서로 한 행에 저장하고, usage는 셋의 합·원가는 호출마다 계산한 합", async () => {
    const s = await setup((p) => staged(p));
    await s.run();
    const e = await s.report();
    expect(e.status).toBe("done");
    const c = await s.content();
    expect(parts(c)).toEqual(["nag_open", "nag_cards", "nag_cards", "nag_last"]);
    expect(c.sections.map((x) => x.about)).toEqual(["pair", "철수", "민지", "pair"]);
    // 제목·소제·진행 메모는 ①의 것
    expect([c.headline, c.dek, c.reading_notes]).toEqual(["리포트 헤드라인", "사흘 동안의 흐름", [{ range: "10-01~10-03", note: "저녁마다 이야기했다" }]]);
    expect(c.checks).toMatchObject({ calls: { intro: "ok", people: "ok", outro: "ok" }, off_stage: 0 });
    expect(s.finish).toHaveBeenCalledTimes(1);
    expect(lastFinish(s.finish)).toEqual({
      id: s.id,
      status: "done",
      content: e.content,
      model: "claude-sonnet-5-5",
      stopReason: "end_turn",
      errorCode: null,
      usage: withReads(2),
      cost: estimateCostUsd(ONE, "claude-sonnet-5-5") + 2 * estimateCostUsd(READ_ONE, "claude-sonnet-5-5"),
    });
  });

  it("①을 먼저 보내고 ①의 message_start 뒤에야 ②·③을 같은 함수 안에서 동시에 시작한다(①이 끝나기 전)", async () => {
    let atStart = () => {};
    let atEnd = () => {};
    const start = new Promise<void>((r) => (atStart = r));
    const end = new Promise<void>((r) => (atEnd = r));
    const text = JSON.stringify(stageJson("intro"));
    const s = await setup((p) =>
      staged(p, { intro: { steps: [() => start, messageStart(), textStart, delta(text), () => end, blockStop, messageDelta("end_turn"), messageStop] } }),
    );
    expect(await s.h.repo.startReport(s.id)).toBe(true);
    const done = runReportJob(s.h.deps, { id: s.id, payload: s.payload });
    await until(() => s.h.streams.length === 1);
    await new Promise((r) => setTimeout(r, 30));
    // ①이 응답을 시작하기 전(캐시가 써지기 전)에는 나머지를 보내지 않는다
    expect(s.sent()).toEqual(["intro"]);
    atStart();
    await until(() => s.h.streams.length === 3);
    // ①은 아직 끝나지 않았다
    expect((await s.report()).status).toBe("running");
    expect(s.sent()).toEqual(["intro", "people", "outro"]);
    atEnd();
    await done;
    expect((await s.report()).status).toBe("done");
  });

  it("호출마다 system·데이터 블록(cache_control ephemeral)·모델·thinking·output_config가 같고 마지막 지시만 다르다", async () => {
    const s = await setup((p) => staged(p));
    await s.run();
    const bodies = s.h.streams.map((x) => x.body);
    expect(bodies).toHaveLength(3);
    const shared = (b: (typeof bodies)[number]) => JSON.stringify([b.system, b.messages[0], b.model, b.thinking, b.output_config, b.betas, b.fallbacks]);
    for (const b of bodies) {
      expect(shared(b)).toBe(shared(bodies[0]));
      expect((b.messages[0].content as { cache_control?: unknown }[])[0].cache_control).toEqual({ type: "ephemeral" });
      expect(b.messages[1].role).toBe("system");
      expect(b.stream).toBe(true);
    }
    expect(new Set(bodies.map(instructionOf)).size).toBe(3);
  });

  it("호출마다 usage(캐시 쓰기·읽기 포함)를 더해 한 행으로 남기고, 원가는 호출마다 계산해 더한다", async () => {
    const big = 480_000;
    const s = await setup((p) =>
      staged(p, {
        intro: whole(JSON.stringify(stageJson("intro")), { usage: { input_tokens: 50, cache_creation_input_tokens: big }, output: 8_000 }),
        people: whole(JSON.stringify(stageJson("people")), { usage: { input_tokens: 60, cache_read_input_tokens: big }, output: 15_000 }),
        outro: whole(JSON.stringify(stageJson("outro")), { usage: { input_tokens: 55, cache_read_input_tokens: big }, output: 8_000 }),
      }),
    );
    await s.run();
    const f = lastFinish(s.finish);
    expect(f.usage).toEqual({ input_tokens: 165, output_tokens: 31_000, cache_creation_input_tokens: big, cache_read_input_tokens: 2 * big });
    // Sonnet 5.5: 쓰기 $2.5·읽기 $0.10·입력 $2·출력 $10 /MTok → ① $1.2801 + ② $0.19812 + ③ $0.12811
    expect(f.cost).toBeCloseTo(1.2801 + 0.19812 + 0.12811, 10);
    expect(s.finish).toHaveBeenCalledTimes(1);
  });

  it("② 개인별이 실패하면(응답 전 fatal) ①·③으로 partial을 저장한다. 오류 코드는 비우고 checks.calls에 남긴다", async () => {
    const s = await setup((p) => staged(p, { people: http(400, "invalid_request_error") }));
    await s.run();
    const e = await s.report();
    expect(e).toMatchObject({ status: "partial", errorCode: null });
    const c = await s.content();
    expect(parts(c)).toEqual(["nag_open", "nag_last"]);
    expect(c.checks?.calls).toEqual({ intro: "ok", people: "fatal", outro: "ok" });
    expect(s.sent()).toEqual(["intro", "people", "outro"]);
    // 응답 전에 실패한 ②는 usage가 없다
    expect(lastFinish(s.finish).usage).toEqual(withReads(1));
  });

  it("②가 응답 전 일시 오류면 ②만 한 번 다시 한다", async () => {
    const s = await setup((p) => staged(p, { people: (n) => (n === 1 ? http(503, "api_error") : whole(JSON.stringify(stageJson("people")))) }));
    await s.run();
    expect((await s.report()).status).toBe("done");
    expect([...s.sent()].sort()).toEqual(["intro", "outro", "people", "people"]);
  });

  it("①이 응답 전 일시 오류면 ①을 한 번 다시 하고, 다시 한 ①의 message_start 뒤에 ②·③을 시작한다", async () => {
    const s = await setup((p) => staged(p, { intro: (n) => (n === 1 ? http(503, "api_error") : whole(JSON.stringify(stageJson("intro")))) }));
    await s.run();
    expect((await s.report()).status).toBe("done");
    expect(s.sent()).toEqual(["intro", "intro", "people", "outro"]);
  });

  it("①이 끝내 응답을 시작하지 못하면 ②·③은 시작하지 않는다(캐시 없이 셋이 쓰지 않게) → failed", async () => {
    const s = await setup((p) => staged(p, { intro: http(529, "overloaded_error") }));
    await s.run();
    expect(await s.report()).toMatchObject({ status: "failed", errorCode: "retryable" });
    expect(s.sent()).toEqual(["intro", "intro"]);
    expect(lastFinish(s.finish)).toMatchObject({ usage: null, cost: 0, model: null });
  });

  it("어느 호출이든 safety.flag가 none이 아니면 safety(도움 안내)", async () => {
    const s = await setup((p) => staged(p, { outro: whole(JSON.stringify(stageJson("outro", { safety: { flag: "self_harm" } }))) }));
    await s.run();
    expect(await s.report()).toMatchObject({ status: "safety", content: null, errorCode: null });
  });

  it("②가 마감에 끊기면 완결된 사람 섹션만 남기고 partial. ②의 출력 usage는 max_tokens 상한으로 센다", async () => {
    const people = JSON.stringify(stageJson("people"));
    const s = await setup((p) => staged(p, { people: cut(people.slice(0, people.lastIndexOf('"quote"'))) }), { deadlineMs: 300 });
    await s.run();
    const e = await s.report();
    expect(e).toMatchObject({ status: "partial", errorCode: null });
    const c = await s.content();
    expect(c.sections.map((x) => x.about)).toEqual(["pair", "철수", "pair"]);
    expect(c.checks?.calls).toMatchObject({ people: "timeout" });
    const maxTokens = s.h.streams[0].body.max_tokens as number;
    expect(lastFinish(s.finish).usage).toEqual({ input_tokens: 300, output_tokens: 200 + maxTokens + 200, cache_creation_input_tokens: 0, cache_read_input_tokens: CACHE_READ });
  });

  it("②가 max_tokens로 잘리면 완결된 섹션만 살려 partial", async () => {
    const people = JSON.stringify(stageJson("people"));
    const s = await setup((p) => staged(p, { people: whole(people.slice(0, people.lastIndexOf('"quote"')), { stop: "max_tokens" }) }));
    await s.run();
    const c = await s.content();
    expect((await s.report()).status).toBe("partial");
    expect(c.sections.map((x) => x.about)).toEqual(["pair", "철수", "pair"]);
    expect(c.checks?.calls).toMatchObject({ people: "max_tokens" });
    expect(lastFinish(s.finish).stopReason).toBe("max_tokens");
  });

  it("거절: 하나만 거절하면 나머지로 partial, 모든 호출이 거절하면 refused(거절 분류는 errorCode에)", async () => {
    const one = await setup((p) => staged(p, { intro: whole("{}", { stop: "refusal", stopCategory: "cyber" }) }));
    await one.run();
    expect(await one.report()).toMatchObject({ status: "partial", errorCode: null });
    const c = await one.content();
    expect(parts(c)).toEqual(["nag_cards", "nag_cards", "nag_last"]);
    // ①이 빠지면 제목·소제도 없다(화면은 연재 제목으로 대신한다)
    expect([c.headline, c.dek, c.checks?.calls?.intro]).toEqual(["", "", "refused"]);

    const all = await setup(() => () => whole(JSON.stringify(reportJson()), { stop: "refusal", stopCategory: "cyber" }));
    await all.run();
    expect(await all.report()).toMatchObject({ status: "refused", content: null, errorCode: "refusal_cyber" });
    expect(lastFinish(all.finish)).toMatchObject({ stopReason: "refusal", usage: times(3) });

    const unnamed = await setup(() => () => whole("{}", { stop: "refusal" }));
    await unnamed.run();
    expect(await unnamed.report()).toMatchObject({ status: "refused", content: null, errorCode: null });
  });

  it("다른 몫의 섹션은 뺀다: ①이 개인별·마무리까지 쓴 긴 리포트(SSE 여러 조각)에서도 ①의 인트로 몫만 남고 off_stage로 센다", async () => {
    const text = JSON.stringify(longReportJson());
    const chunks = Array.from({ length: Math.ceil(text.length / 400) }, (_, i) => delta(text.slice(i * 400, (i + 1) * 400)));
    expect(chunks.length).toBeGreaterThan(20);
    const s = await setup((p) => staged(p, { intro: { steps: [messageStart(), textStart, ...chunks, blockStop, messageDelta("end_turn", 12_000), messageStop] } }));
    await s.run();
    expect((await s.report()).status).toBe("done");
    const c = await s.content();
    // longReportJson: nag_open, nag_cards×2, nag_room×6, nag_last 중 인트로 자리(nag_open·nag_room) 7개 + ②의 사람 2 + ③의 마무리 1
    expect(parts(c)).toEqual(["nag_open", ...Array(6).fill("nag_room"), "nag_cards", "nag_cards", "nag_last"]);
    expect(c.sections.flatMap((x) => x.paragraphs)).toHaveLength(7 * 5 + 3);
    expect(c.checks).toMatchObject({ off_stage: 3, dropped_by: {} });
    expect(c.reading_notes).toHaveLength(12);
  });

  it("응답은 끝났는데 자기 몫 섹션이 하나도 없는 호출(②가 인트로만 썼다)은 empty: 그 부분이 빠졌으니 partial", async () => {
    const s = await setup((p) => staged(p, { people: whole(JSON.stringify(stageJson("intro"))) }));
    await s.run();
    expect(await s.report()).toMatchObject({ status: "partial", errorCode: null });
    const c = await s.content();
    expect(parts(c)).toEqual(["nag_open", "nag_last"]);
    expect(c.checks).toMatchObject({ calls: { intro: "ok", people: "empty", outro: "ok" }, off_stage: 1 });
  });

  it("①이 JSON이 아니면 ①만 빠진 partial, 모두 JSON이 아니면 failed(invalid_output). usage는 남긴다", async () => {
    const one = await setup((p) => staged(p, { intro: whole("{ 이건 JSON이 아니다") }));
    await one.run();
    expect(await one.report()).toMatchObject({ status: "partial", errorCode: null });
    expect((await one.content()).checks?.calls).toMatchObject({ intro: "invalid_output" });

    const all = await setup(() => () => whole("{ 이건 JSON이 아니다"));
    await all.run();
    expect(await all.report()).toMatchObject({ status: "failed", errorCode: "invalid_output", content: null });
    expect(lastFinish(all.finish).usage).toEqual(times(3));
  });

  it("응답이 시작되기 전에 마감 → failed(timeout). usage·모델 없음", async () => {
    const s = await setup(() => () => ({ steps: [], open: true }), { deadlineMs: 50 });
    await s.run();
    expect(await s.report()).toMatchObject({ status: "failed", errorCode: "timeout" });
    expect(lastFinish(s.finish)).toMatchObject({ usage: null, cost: 0, model: null });
    expect(s.sent()).toEqual(["intro"]);
  });

  describe("응답 시작 뒤 오류(R8): 받은 글을 partial 경로로", () => {
    it("①의 완결된 섹션이 남으면 그것과 ②·③으로 partial. 다시 하지 않는다", async () => {
      const s = await setup((p) => staged(p, { intro: failsAfter(cutInSecondSection()) }));
      await s.run();
      const e = await s.report();
      expect(e).toMatchObject({ status: "partial", errorCode: null });
      expect(parts(await s.content())).toEqual(["nag_open", "nag_cards", "nag_cards", "nag_last"]);
      expect(s.sent()).toEqual(["intro", "people", "outro"]);
      expect((lastFinish(s.finish).usage as { output_tokens: number }).output_tokens).toBe((s.h.streams[0].body.max_tokens as number) + 400);
    });

    it("safety가 none이 아니면 safety", async () => {
      const s = await setup((p) => staged(p, { intro: failsAfter('{"safety":{"flag":"self_harm"},"declined') }));
      await s.run();
      expect(await s.report()).toMatchObject({ status: "safety", content: null });
    });

    it("모든 호출이 살릴 섹션 없이 끊기면 분류한 오류로 failed", async () => {
      const s = await setup(() => () => failsAfter('{"safety":{"flag":"none"},"reading_notes":['));
      await s.run();
      expect(await s.report()).toMatchObject({ status: "failed", errorCode: "retryable" });
      expect(s.h.streams).toHaveLength(3);
    });
  });

  it("spend_limit(429)이 ①에서 나면 다음 달 1일 00:00 UTC까지 정지, failed(limit), 나머지는 시작하지 않는다", async () => {
    const s = await setup(() => () => http(429, "rate_limit_error", { details: { error_code: "enforced_spend_limit_reached" } }));
    await s.run();
    const now = new Date();
    expect(s.setPaused).toHaveBeenCalledTimes(1);
    expect(s.setPaused).toHaveBeenCalledWith(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)));
    expect(await s.report()).toMatchObject({ status: "failed", errorCode: "limit" });
    expect(s.h.streams).toHaveLength(1);
    expect(lastFinish(s.finish)).toMatchObject({ usage: null, cost: 0 });
  });

  it("한도 오류가 ③에서 나면 정지 시각을 걸고 ①·②로 partial(지금 규칙: 살린 글이 있으면 오류 코드 없음)", async () => {
    const s = await setup((p) => staged(p, { outro: http(402, "billing_error", { message: "Your credit balance is too low" }) }));
    await s.run();
    expect(s.setPaused).toHaveBeenCalledWith(nextCycleStart(new Date(), CYCLE_ANCHOR_DAY));
    expect(await s.report()).toMatchObject({ status: "partial", errorCode: null });
    expect((await s.content()).checks?.calls).toMatchObject({ outro: "limit" });
  });

  it("credit_exhausted(402)가 ①에서 나면 nextCycleStart(지금, 주기 기준일)까지 정지, failed(limit)", async () => {
    const s = await setup(() => () => http(402, "billing_error", { message: "Your credit balance is too low" }));
    await s.run();
    expect(s.setPaused).toHaveBeenCalledWith(nextCycleStart(new Date(), CYCLE_ANCHOR_DAY));
    expect(await s.report()).toMatchObject({ status: "failed", errorCode: "limit" });
    expect(s.h.streams).toHaveLength(1);
  });

  it("60초가 지난 뒤의 retryable이나 fatal은 다시 하지 않는다", async () => {
    const late = await setup(() => () => {
      // 첫 시도가 61초 뒤에 실패한 것처럼
      late.h.state.skew = 61_000;
      return http(529, "overloaded_error");
    });
    await late.run();
    expect(late.h.streams).toHaveLength(1);
    expect(await late.report()).toMatchObject({ status: "failed", errorCode: "retryable" });

    const fatal = await setup(() => () => http(400, "invalid_request_error"));
    await fatal.run();
    expect(fatal.h.streams).toHaveLength(1);
    expect(await fatal.report()).toMatchObject({ status: "failed", errorCode: "fatal" });
  });

  it("응답 모델이 요청 모델과 다르면 호출마다 fallback_on_writer를 기록하고 실제 모델로 원가를 센다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Sonnet 5.5의 기본 폴백 대상
    const s = await setup((p) => {
      const partOf = partsOf(p);
      return (_n, body) => whole(JSON.stringify(stageJson(partOf(body))), { model: "claude-sonnet-5" });
    });
    await s.run();
    const warned = warn.mock.calls.map(([m]) => String(m));
    expect(warned.filter((m) => m.includes("fallback_on_writer")).sort()).toEqual(
      ["intro", "outro", "people"].map((part) => `[jobs] fallback_on_writer(${part}): claude-sonnet-5-5 → claude-sonnet-5`),
    );
    // 이 가짜 응답은 캐시를 읽지 않았다(폴백 모델은 캐시가 따로다): ① 뒤 호출마다 cache_miss
    expect(warned.filter((m) => m.includes("cache_miss")).sort()).toEqual(["[jobs] cache_miss(outro)", "[jobs] cache_miss(people)"]);
    const finish = lastFinish(s.finish);
    expect(finish).toMatchObject({ status: "done", model: "claude-sonnet-5" });
    expect(finish.cost).toBeCloseTo(3 * estimateCostUsd(ONE, "claude-sonnet-5"), 12);
  });

  it("스트리밍 중 ①의 정리된 reading_notes만 saveProgress로 남긴다(②·③의 메모는 쓰지 않는다)", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const text = JSON.stringify(stageJson("intro"));
    const at = text.indexOf('"headline"');
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const noisy = (part: "people" | "outro") => whole(JSON.stringify(stageJson(part, { reading_notes: [{ range: "10-02~10-02", note: "다른 몫의 메모" }] })));
    const s = await setup((p) =>
      staged(p, {
        intro: { steps: [messageStart(), textStart, delta(text.slice(0, at)), () => gate, delta(text.slice(at)), blockStop, messageDelta("end_turn"), messageStop] },
        people: noisy("people"),
        outro: noisy("outro"),
      }),
    );
    expect(await s.h.repo.startReport(s.id)).toBe(true);
    const done = runReportJob(s.h.deps, { id: s.id, payload: s.payload });
    await until(() => s.h.streams.length === 3);
    await new Promise((r) => setTimeout(r, 30));
    await vi.advanceTimersByTimeAsync(NOTES_FLUSH_MS);
    expect(await s.report()).toMatchObject({ status: "running", progress: [{ range: "10-01~10-03", note: "저녁마다 이야기했다" }] });
    release();
    await done;
    expect((await s.report()).status).toBe("done");
    expect((await s.content()).reading_notes).toEqual([{ range: "10-01~10-03", note: "저녁마다 이야기했다" }]);
  });

  it("사람이 4명 이상이면 개인별을 상위 3명 / 나머지로 나눠 네 번 부르고, 다른 개인별 호출이 맡은 사람 섹션은 뺀다", async () => {
    const payload = makeGroupPayload();
    const idx = payloadIndex(payload);
    const refOf = (name: string) => [...idx].find(([, line]) => line.sender === name)![0];
    const person = (name: string) => ({
      part: "nag_cards",
      icon: "🙄",
      title: `${name} 카드`,
      about: name,
      paragraphs: [{ key: "p1", text: `${name}는 저녁마다 먼저 왔다`, evidence_ids: ["e1"] }],
      evidence: [{ id: "e1", msg_id: refOf(name), quote: `${name} 왔어` }],
    });
    const blank = { reading_notes: [], headline: "", dek: "" };
    const s = await setup(
      (p) =>
        staged(p, {
          // ②a는 맡은 셋에 더해 ②b가 맡은 지훈까지 썼다 → 지훈은 ②b의 것만 남는다
          people: whole(JSON.stringify(reportJson({ ...blank, sections: ["민지", "철수", "영희", "지훈"].map(person) }))),
          people_rest: whole(JSON.stringify(reportJson({ ...blank, sections: ["지훈", "수아"].map(person) }))),
        }),
      { payload },
    );
    await s.run();
    expect([...s.sent()].sort()).toEqual(["intro", "outro", "people", "people_rest"]);
    expect(s.sent()[0]).toBe("intro");
    const c = await s.content();
    expect((await s.report()).status).toBe("done");
    expect(c.sections.map((x) => x.about)).toEqual(["group", ...GROUP_NAMES, "group"].map((a) => (a === "group" ? "pair" : a)));
    expect(c.checks).toMatchObject({ calls: { intro: "ok", people: "ok", people_rest: "ok", outro: "ok" }, off_stage: 1 });
    // ②a·②b는 이 테스트에서 캐시 읽기 없이 답했다(마무리만 읽었다)
    expect(lastFinish(s.finish).usage).toEqual({ ...times(4), cache_read_input_tokens: CACHE_READ });
  });

  it("about에 범례 기호를 쓴 사람 섹션도 표시 이름으로 바꿔 합치고, 다른 개인별 호출이 맡은 사람이면 뺀다(리뷰 minor 6)", async () => {
    const payload = makeGroupPayload();
    const idx = payloadIndex(payload);
    const code = (name: string) => memberCodes(payload.members)[payload.members.indexOf(name)];
    const refOf = (name: string) => [...idx].find(([, line]) => line.sender === name)![0];
    const person = (name: string, about: string) => ({
      part: "nag_cards",
      icon: "🙄",
      title: `${name} 카드`,
      about,
      paragraphs: [{ key: "p1", text: `${name}는 저녁마다 먼저 왔다`, evidence_ids: ["e1"] }],
      evidence: [{ id: "e1", msg_id: refOf(name), quote: `${name} 왔어` }],
    });
    const blank = { reading_notes: [], headline: "", dek: "" };
    const s = await setup(
      (p) =>
        staged(p, {
          people: whole(JSON.stringify(reportJson({ ...blank, sections: [...["민지", "철수", "영희"].map((n) => person(n, n)), person("지훈", code("지훈"))] }))),
          people_rest: whole(JSON.stringify(reportJson({ ...blank, sections: ["지훈", "수아"].map((n) => person(n, code(n))) }))),
        }),
      { payload },
    );
    await s.run();
    const c = await s.content();
    expect(c.sections.map((x) => x.about)).toEqual(["pair", ...GROUP_NAMES, "pair"]);
    expect(c.checks?.off_stage).toBe(1);
  });

  it("②·③이 message_start에서 캐시를 읽지 못했으면(cache_read 0) 몫 이름만 남겨 알린다(리뷰 minor 1)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup((p) => staged(p, { outro: whole(JSON.stringify(stageJson("outro"))) }));
    await s.run();
    expect(warn.mock.calls.map(([m]) => m)).toEqual(["[jobs] cache_miss(outro)"]);
    expect((await s.report()).status).toBe("done");
  });

  it("429(rate limit)면 retry-after만큼 기다렸다 그 호출만 다시 한다(리뷰 minor 2)", async () => {
    const s = await setup((p) => staged(p, { people: (n) => (n === 1 ? rateLimited({ "retry-after-ms": "120" }) : stageReply("people")) }));
    await s.run();
    expect((await s.report()).status).toBe("done");
    const people = s.h.streams.filter((_, i) => s.sent()[i] === "people");
    expect(people).toHaveLength(2);
    expect(people[1].at - people[0].at).toBeGreaterThanOrEqual(120);
  });

  it("retry-after가 재시도 창(60초)을 넘으면 기다리지 않고 그 몫을 뺀다(partial)", async () => {
    const s = await setup((p) => staged(p, { people: rateLimited({ "retry-after": "120" }) }));
    await s.run();
    expect(await s.report()).toMatchObject({ status: "partial", errorCode: null });
    expect((await s.content()).checks?.calls).toMatchObject({ people: "retryable" });
    expect(s.sent().filter((x) => x === "people")).toHaveLength(1);
  });

  it("호출이 다 돈 뒤 저장에서 예상 못 한 오류가 나도 호출 합 usage·원가를 failed(internal)과 함께 남긴다(리뷰 minor 4)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = await setup((p) => staged(p));
    s.finish.mockRejectedValueOnce(new Error("[test] DB 끊김"));
    await s.run();
    expect(s.finish).toHaveBeenCalledTimes(2);
    expect(lastFinish(s.finish)).toEqual({
      id: s.id,
      status: "failed",
      content: null,
      model: "claude-sonnet-5-5",
      stopReason: null,
      errorCode: "internal",
      usage: withReads(2),
      cost: estimateCostUsd(ONE, "claude-sonnet-5-5") + 2 * estimateCostUsd(READ_ONE, "claude-sonnet-5-5"),
    });
    expect(await s.report()).toMatchObject({ status: "failed", errorCode: "internal" });
    expect(error.mock.calls.map(([m]) => m)).toEqual(["[jobs] 리포트 실행 실패: [test] DB 끊김"]);
  });

  it("예상 못 한 오류는 failed(internal)로 남기고 던지지 않는다", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = await setup((p) => staged(p));
    await s.run({
      ...s.h.deps,
      deadlineAt: () => {
        throw new Error("[test] 마감 계산 실패");
      },
    });
    expect(s.finish.mock.calls).toEqual([[expect.objectContaining({ status: "failed", errorCode: "internal", usage: null })]]);
    expect(await s.report()).toMatchObject({ status: "failed", errorCode: "internal" });
    expect(s.h.streams).toHaveLength(0);
    expect(error.mock.calls.map(([m]) => m)).toEqual(["[jobs] 리포트 실행 실패: [test] 마감 계산 실패"]);
  });

  it("client가 없으면 failed(not_ready). Anthropic을 부르지 않는다", async () => {
    const s = await setup((p) => staged(p));
    await s.run({ ...s.h.deps, client: null });
    expect(await s.report()).toMatchObject({ status: "failed", errorCode: "not_ready" });
    expect(s.h.streams).toHaveLength(0);
  });

  describe("실행 한 번 = finishReport 한 번(usage 한 행), deps.fetch는 부르지 않는다", () => {
    it.each<[string, (p: Payload) => ReplyFn, object]>([
      ["ok", (p) => staged(p), { status: "done" }],
      ["② max_tokens 살리기", (p) => staged(p, { people: whole(cutInSecondSection(), { stop: "max_tokens" }) }), { status: "partial" }],
      ["refusal", () => () => whole("{}", { stop: "refusal" }), { status: "refused" }],
      ["① 응답 시작 뒤 오류 살리기(R8)", (p) => staged(p, { intro: failsAfter(cutInSecondSection()) }), { status: "partial" }],
      ["① 응답 전 retryable → 재시도 → ok", (p) => staged(p, { intro: (n) => (n === 1 ? http(503, "api_error") : whole(JSON.stringify(stageJson("intro")))) }), { status: "done" }],
      ["재시도도 retryable", () => () => http(529, "overloaded_error"), { status: "failed", errorCode: "retryable" }],
      ["fatal", () => () => http(400, "invalid_request_error"), { status: "failed", errorCode: "fatal" }],
      ["② fatal", (p) => staged(p, { people: http(400, "invalid_request_error") }), { status: "partial" }],
    ])("%s", async (_label, reply, expected) => {
      const s = await setup(reply);
      await s.run();
      expect(s.finish).toHaveBeenCalledTimes(1);
      expect(await s.report()).toMatchObject(expected);
      expect(s.h.fetches).toHaveLength(0);
    });

    it("마감에 끊겨도 한 번", async () => {
      const s = await setup(() => () => cut(cutInSecondSection()), { deadlineMs: 150 });
      await s.run();
      expect(s.finish).toHaveBeenCalledTimes(1);
      expect(s.h.fetches).toHaveLength(0);
    });
  });
});

describe("nextCycleStart (주기는 기준일 00:00 서울에 시작한다)", () => {
  const at = (iso: string) => new Date(iso);
  it.each([
    ["2026-11-24T03:00:00Z", 1, "2026-11-30T15:00:00.000Z"],
    ["2026-11-30T14:59:59Z", 1, "2026-11-30T15:00:00.000Z"],
    // 서울 12-01 00:00 = 이번 주기의 시작이라 다음은 1월
    ["2026-11-30T15:00:00Z", 1, "2026-12-31T15:00:00.000Z"],
    ["2026-12-10T00:00:00Z", 1, "2026-12-31T15:00:00.000Z"],
    ["2026-11-10T00:00:00Z", 15, "2026-11-14T15:00:00.000Z"],
    ["2026-11-14T15:00:00Z", 15, "2026-12-14T15:00:00.000Z"],
    ["2026-11-20T00:00:00Z", 15, "2026-12-14T15:00:00.000Z"],
  ])("%s, 기준일 %i → %s", (now, anchor, expected) => {
    expect(nextCycleStart(at(now), anchor).toISOString()).toBe(expected);
  });
});
