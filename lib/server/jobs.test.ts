import { afterEach, describe, expect, it, vi } from "vitest";
import { CYCLE_ANCHOR_DAY, NOTES_FLUSH_MS } from "@/lib/config";
import { hashCode } from "@/lib/invite/code";
import { estimateCostUsd } from "@/lib/llm/cost";
import { PROMPT_VERSION } from "@/lib/llm/prompt";
import { sha256Hex } from "@/lib/payload/hash";
import {
  blockStop,
  CODE,
  cut,
  cutInSecondSection,
  delta,
  episodeJson,
  harness,
  makePayload,
  messageDelta,
  messageStart,
  messageStop,
  type Reply,
  sseError,
  textStart,
  until,
  whole,
} from "@/test/generation";
import { nextCycleStart, runReportJob } from "./jobs";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const ok = (n: number) => whole(JSON.stringify(episodeJson(n)));

/** 대화 하나를 만들어 두고 runReportJob을 직접 부른다 */
async function setup(reply: (n: number, call: number) => Reply, o: Parameters<typeof harness>[0] = {}) {
  const h = await harness({ reply, ...o });
  const payload = makePayload();
  const invite = await h.repo.findInvite(hashCode(CODE));
  const payloadSha256 = await sha256Hex(JSON.stringify(payload));
  const claim = await h.repo.claim({
    inviteId: invite!.id,
    concept: payload.concept,
    payloadSha256,
    meta: { prompt_version: PROMPT_VERSION, tone: payload.tone, kind: payload.kind, display_names: payload.members, stats: payload.stats },
    estCost: 1.2,
  });
  const id = claim.id!;
  const report = async () => (await h.repo.getConversation(id))!.report;
  const run = async (deps = h.deps) => {
    expect(await h.repo.startReport(id)).toBe(true);
    await runReportJob(deps, { id, payload });
    await h.settle();
  };
  const finish = vi.spyOn(h.repo, "finishReport");
  const setPaused = vi.spyOn(h.repo, "setPaused");
  return { h, payload, payloadSha256, id, report, run, finish, setPaused };
}

const lastFinish = (finish: { mock: { calls: unknown[][] } }) => finish.mock.calls.at(-1)?.[0] as Record<string, unknown>;

describe("runReportJob 결과 처리", () => {
  it("ok → done. finishReport에 실제 모델·stop_reason·usage·원가를 넘긴다", async () => {
    const s = await setup(ok);
    await s.run();
    const e = await s.report();
    expect(e.status).toBe("done");
    expect(e.content?.sections).toHaveLength(2);
    const usage = { input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    expect(lastFinish(s.finish)).toEqual({
      id: s.id,
      status: "done",
      content: e.content,
      model: "claude-opus-5-5",
      stopReason: "end_turn",
      errorCode: null,
      usage,
      cost: estimateCostUsd(usage, "claude-opus-5-5"),
    });
  });

  it("ok인데 JSON이 아니면 failed(invalid_output). usage는 남긴다", async () => {
    const s = await setup(() => whole('{"episode":1, 이건 JSON이 아니다'));
    await s.run();
    expect(await s.report()).toMatchObject({ status: "failed", errorCode: "invalid_output", content: null });
    expect(lastFinish(s.finish).usage).not.toBeNull();
  });

  it("max_tokens(truncated) → 완결된 섹션만 살려 partial. 검증 결과가 done이어도 partial", async () => {
    const s = await setup((n) => whole(cutInSecondSection(n), { stop: "max_tokens" }));
    await s.run();
    const e = await s.report();
    expect(e.status).toBe("partial");
    expect(e.content?.sections.map((x) => x.title)).toEqual(["저녁의 리듬"]);

    const full = await setup((n) => whole(JSON.stringify(episodeJson(n)), { stop: "max_tokens" }));
    await full.run();
    expect((await full.report()).status).toBe("partial");
    expect((await full.report()).content?.sections).toHaveLength(2);
  });

  it("refusal → refused. 파싱하지 않고 내용 없이, usage는 남긴다", async () => {
    const s = await setup(() => whole(JSON.stringify(episodeJson(1)), { stop: "refusal" }));
    await s.run();
    expect(await s.report()).toMatchObject({ status: "refused", content: null, errorCode: null });
    expect(lastFinish(s.finish)).toMatchObject({ stopReason: "refusal", usage: expect.objectContaining({ output_tokens: 200 }) });
  });

  it("마감에 끊기면 완결된 섹션만 partial, 출력 usage는 max_tokens 상한 그대로", async () => {
    const s = await setup((n) => cut(cutInSecondSection(n)), { deadlineMs: 150 });
    await s.run();
    const e = await s.report();
    expect(e.status).toBe("partial");
    expect(e.content?.sections).toHaveLength(1);
    const maxTokens = s.h.streams[0].body.max_tokens as number;
    expect(lastFinish(s.finish).usage).toEqual({
      input_tokens: 100,
      output_tokens: maxTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it("응답이 시작되기 전에 마감 → failed(timeout). usage·모델 없음", async () => {
    const s = await setup(() => ({ steps: [], open: true }), { deadlineMs: 50 });
    await s.run();
    expect(await s.report()).toMatchObject({ status: "failed", errorCode: "timeout" });
    expect(lastFinish(s.finish)).toMatchObject({ usage: null, cost: 0, model: null });
  });

  describe("응답 시작 뒤 오류(R8): 받은 글을 partial 경로로", () => {
    const failsAfter = (text: string): Reply => ({ steps: [messageStart(), textStart, delta(text), sseError("overloaded_error")] });

    it("완결된 섹션이 1개 이상이면 partial. 다시 하지 않는다", async () => {
      const s = await setup((n) => failsAfter(cutInSecondSection(n)));
      await s.run();
      const e = await s.report();
      expect(e).toMatchObject({ status: "partial", errorCode: null });
      expect(e.content?.sections).toHaveLength(1);
      expect(s.h.streams).toHaveLength(1);
      expect(lastFinish(s.finish).usage).toMatchObject({ output_tokens: s.h.streams[0].body.max_tokens });
    });

    it("safety가 none이 아니면 safety", async () => {
      const s = await setup(() => failsAfter('{"episode":1,"safety":{"flag":"self_harm"},"declined'));
      await s.run();
      expect(await s.report()).toMatchObject({ status: "safety", content: null });
    });

    it("살릴 섹션이 없으면 분류한 오류로 failed", async () => {
      const s = await setup(() => failsAfter('{"episode":1,"safety":{"flag":"none"},"reading_notes":['));
      await s.run();
      expect(await s.report()).toMatchObject({ status: "failed", errorCode: "retryable" });
      expect(s.h.streams).toHaveLength(1);
    });
  });

  it("spend_limit(429) → 다음 달 1일 00:00 UTC까지 정지, failed(limit), 다시 하지 않는다", async () => {
    const s = await setup(() => ({
      status: 429,
      error: { type: "rate_limit_error", message: "spend limit", details: { error_code: "enforced_spend_limit_reached" } },
    }));
    await s.run();
    const now = new Date();
    expect(s.setPaused).toHaveBeenCalledTimes(1);
    expect(s.setPaused).toHaveBeenCalledWith(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)));
    expect(await s.report()).toMatchObject({ status: "failed", errorCode: "limit" });
    expect(s.h.streams).toHaveLength(1);
    expect(lastFinish(s.finish)).toMatchObject({ usage: null, cost: 0 });
  });

  it("credit_exhausted(402) → nextCycleStart(지금, 주기 기준일)까지 정지, failed(limit)", async () => {
    const s = await setup(() => ({ status: 402, error: { type: "billing_error", message: "Your credit balance is too low" } }));
    await s.run();
    expect(s.setPaused).toHaveBeenCalledWith(nextCycleStart(new Date(), CYCLE_ANCHOR_DAY));
    expect(await s.report()).toMatchObject({ status: "failed", errorCode: "limit" });
    expect(s.h.streams).toHaveLength(1);
  });

  it("retryable(5xx)이고 응답 전·60초 안이면 같은 함수에서 1번만 다시 한다", async () => {
    const s = await setup((n, call) => (call === 1 ? { status: 503, error: { type: "api_error", message: "unavailable" } } : ok(n)));
    await s.run();
    expect(s.h.streams).toHaveLength(2);
    expect((await s.report()).status).toBe("done");
  });

  it("60초가 지난 뒤의 retryable이나 fatal은 다시 하지 않는다", async () => {
    const late = await setup(() => {
      // 첫 시도가 61초 뒤에 실패한 것처럼
      late.h.state.skew = 61_000;
      return { status: 529, error: { type: "overloaded_error", message: "Overloaded" } };
    });
    await late.run();
    expect(late.h.streams).toHaveLength(1);
    expect(await late.report()).toMatchObject({ status: "failed", errorCode: "retryable" });

    const fatal = await setup(() => ({ status: 400, error: { type: "invalid_request_error", message: "bad" } }));
    await fatal.run();
    expect(fatal.h.streams).toHaveLength(1);
    expect(await fatal.report()).toMatchObject({ status: "failed", errorCode: "fatal" });
  });

  it("응답 모델이 요청 모델과 다르면 fallback_on_writer를 기록하고 실제 모델로 원가를 센다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup((n) => whole(JSON.stringify(episodeJson(n)), { model: "claude-opus-4-8" }));
    await s.run();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/fallback_on_writer/);
    const finish = lastFinish(s.finish);
    expect(finish).toMatchObject({ status: "done", model: "claude-opus-4-8" });
    expect(finish.cost).toBe(estimateCostUsd(finish.usage as never, "claude-opus-4-8"));
  });

  it("스트리밍 중 정리된 reading_notes를 saveProgress로 남긴다", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const text = JSON.stringify(episodeJson(1));
    const at = text.indexOf('"headline"');
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const s = await setup(() => ({
      steps: [messageStart(), textStart, delta(text.slice(0, at)), () => gate, delta(text.slice(at)), blockStop, messageDelta("end_turn"), messageStop],
    }));
    expect(await s.h.repo.startReport(s.id)).toBe(true);
    const done = runReportJob(s.h.deps, { id: s.id, payload: s.payload });
    await until(() => s.h.streams.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    await vi.advanceTimersByTimeAsync(NOTES_FLUSH_MS);
    expect(await s.report()).toMatchObject({ status: "running", progress: [{ range: "10-01~10-03", note: "저녁마다 이야기했다" }] });
    release();
    await done;
    expect((await s.report()).status).toBe("done");
  });

  it("예상 못 한 오류는 failed(internal)로 남기고 던지지 않는다", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = await setup(ok);
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
    const s = await setup(ok);
    await s.run({ ...s.h.deps, client: null });
    expect(await s.report()).toMatchObject({ status: "failed", errorCode: "not_ready" });
    expect(s.h.streams).toHaveLength(0);
  });

  describe("실행 한 번 = finishReport 한 번(usage 한 행), deps.fetch는 부르지 않는다", () => {
    const failsAfter = (text: string): Reply => ({ steps: [messageStart(), textStart, delta(text), sseError("overloaded_error")] });
    it.each<[string, (n: number, call: number) => Reply, object]>([
      ["ok", ok, { status: "done" }],
      ["max_tokens 살리기", (n) => whole(cutInSecondSection(n), { stop: "max_tokens" }), { status: "partial" }],
      ["refusal", () => whole("{}", { stop: "refusal" }), { status: "refused" }],
      ["응답 시작 뒤 오류 살리기(R8)", (n) => failsAfter(cutInSecondSection(n)), { status: "partial" }],
      ["응답 전 retryable → 같은 함수 재시도 → ok", (n, call) => (call === 1 ? { status: 503, error: { type: "api_error", message: "x" } } : ok(n)), { status: "done" }],
      ["재시도도 retryable", () => ({ status: 529, error: { type: "overloaded_error", message: "x" } }), { status: "failed", errorCode: "retryable" }],
      ["fatal", () => ({ status: 400, error: { type: "invalid_request_error", message: "x" } }), { status: "failed", errorCode: "fatal" }],
    ])("%s", async (_label, reply, expected) => {
      const s = await setup(reply);
      await s.run();
      expect(s.finish).toHaveBeenCalledTimes(1);
      expect(await s.report()).toMatchObject(expected);
      expect(s.h.fetches).toHaveLength(0);
    });

    it("마감에 끊겨도 한 번", async () => {
      const s = await setup((n) => cut(cutInSecondSection(n)), { deadlineMs: 150 });
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
