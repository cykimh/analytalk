import { afterEach, describe, expect, it, vi } from "vitest";
import { CYCLE_ANCHOR_DAY, NOTES_FLUSH_MS } from "@/lib/config";
import { hashCode } from "@/lib/invite/code";
import { estimateCostUsd } from "@/lib/llm/cost";
import { PROMPT_VERSION } from "@/lib/llm/prompt";
import { sha256Hex } from "@/lib/payload/hash";
import {
  BASE,
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
  SECRETS,
  sseError,
  textStart,
  until,
  whole,
} from "@/test/generation";
import { dispatchRest, type JobDeps, nextCycleStart, runEpisodeJob, signInternal, verifyInternal } from "./jobs";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const ok = (n: number) => whole(JSON.stringify(episodeJson(n)));
const accepted = async () => new Response(null, { status: 202 });

/**
 * 대화 하나를 만들어 두고 runEpisodeJob을 직접 부른다. 내부 fetch는 기본으로 202만 돌려준다(2~4편은 queued로 남는다)
 */
async function setup(reply: (n: number, call: number) => Reply, o: Parameters<typeof harness>[0] = {}) {
  const h = await harness({ reply, internal: accepted, ...o });
  const payload = makePayload();
  const invite = await h.repo.findInvite(hashCode(CODE));
  const payloadSha256 = await sha256Hex(JSON.stringify(payload));
  const claim = await h.repo.claim({
    inviteId: invite!.id,
    concept: payload.concept,
    payloadSha256,
    meta: { prompt_version: PROMPT_VERSION, kind: payload.kind, display_names: payload.members, stats: payload.stats },
    estCost: 1.31,
  });
  const id = claim.id!;
  const job: JobDeps = { ...h.deps, baseUrl: BASE, baseHeaders: {} };
  const episode = async (n: number) => (await h.repo.getConversation(id))!.episodes.find((e) => e.n === n)!;
  const run = async (n: 1 | 2 | 3 | 4) => {
    expect(await h.repo.startEpisode(id, n)).toBe(true);
    await runEpisodeJob(job, { id, n, payload });
    await h.settle();
  };
  const finish = vi.spyOn(h.repo, "finishEpisode");
  const setPaused = vi.spyOn(h.repo, "setPaused");
  return { h, payload, payloadSha256, id, job, episode, run, finish, setPaused };
}

const lastFinish = (finish: { mock: { calls: unknown[][] } }) => finish.mock.calls.at(-1)?.[0] as Record<string, unknown>;

describe("runEpisodeJob 결과 처리", () => {
  it("ok → done. finishEpisode에 실제 모델·stop_reason·usage·원가를 넘긴다", async () => {
    const s = await setup(ok);
    await s.run(1);
    const e = await s.episode(1);
    expect(e.status).toBe("done");
    expect(e.content?.sections).toHaveLength(2);
    const usage = { input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    expect(lastFinish(s.finish)).toEqual({
      id: s.id,
      n: 1,
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
    await s.run(1);
    expect(await s.episode(1)).toMatchObject({ status: "failed", errorCode: "invalid_output", content: null });
    expect(lastFinish(s.finish).usage).not.toBeNull();
  });

  it("max_tokens(truncated) → 완결된 섹션만 살려 partial. 검증 결과가 done이어도 partial", async () => {
    const s = await setup((n) => whole(cutInSecondSection(n), { stop: "max_tokens" }));
    await s.run(1);
    const e = await s.episode(1);
    expect(e.status).toBe("partial");
    expect(e.content?.sections.map((x) => x.title)).toEqual(["저녁의 리듬"]);

    const full = await setup((n) => whole(JSON.stringify(episodeJson(n)), { stop: "max_tokens" }));
    await full.run(1);
    expect((await full.episode(1)).status).toBe("partial");
    expect((await full.episode(1)).content?.sections).toHaveLength(2);
  });

  it("refusal → refused. 파싱하지 않고 내용 없이, usage는 남긴다", async () => {
    const s = await setup(() => whole(JSON.stringify(episodeJson(1)), { stop: "refusal" }));
    await s.run(1);
    expect(await s.episode(1)).toMatchObject({ status: "refused", content: null, errorCode: null });
    expect(lastFinish(s.finish)).toMatchObject({ stopReason: "refusal", usage: expect.objectContaining({ output_tokens: 200 }) });
  });

  it("마감에 끊기면 완결된 섹션만 partial, 출력 usage는 max_tokens 상한 그대로", async () => {
    const s = await setup((n) => cut(cutInSecondSection(n)), { deadlineMs: 150 });
    await s.run(1);
    const e = await s.episode(1);
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
    await s.run(1);
    expect(await s.episode(1)).toMatchObject({ status: "failed", errorCode: "timeout" });
    expect(lastFinish(s.finish)).toMatchObject({ usage: null, cost: 0, model: null });
  });

  describe("응답 시작 뒤 오류(R8): 받은 글을 partial 경로로", () => {
    const failsAfter = (text: string): Reply => ({ steps: [messageStart(), textStart, delta(text), sseError("overloaded_error")] });

    it("완결된 섹션이 1개 이상이면 partial. 다시 하지 않는다", async () => {
      const s = await setup((n) => failsAfter(cutInSecondSection(n)));
      await s.run(1);
      const e = await s.episode(1);
      expect(e).toMatchObject({ status: "partial", errorCode: null });
      expect(e.content?.sections).toHaveLength(1);
      expect(s.h.streams).toHaveLength(1);
      expect(lastFinish(s.finish).usage).toMatchObject({ output_tokens: s.h.streams[0].body.max_tokens });
    });

    it("safety가 none이 아니면 safety", async () => {
      const s = await setup(() => failsAfter('{"episode":1,"safety":{"flag":"self_harm"},"declined'));
      await s.run(1);
      expect(await s.episode(1)).toMatchObject({ status: "safety", content: null });
    });

    it("살릴 섹션이 없으면 분류한 오류로 failed", async () => {
      const s = await setup(() => failsAfter('{"episode":1,"safety":{"flag":"none"},"reading_notes":['));
      await s.run(1);
      expect(await s.episode(1)).toMatchObject({ status: "failed", errorCode: "retryable" });
      expect(s.h.streams).toHaveLength(1);
    });
  });

  it("spend_limit(429) → 다음 달 1일 00:00 UTC까지 정지, failed(limit), 다시 하지 않는다", async () => {
    const s = await setup(() => ({
      status: 429,
      error: { type: "rate_limit_error", message: "spend limit", details: { error_code: "enforced_spend_limit_reached" } },
    }));
    await s.run(1);
    const now = new Date();
    expect(s.setPaused).toHaveBeenCalledTimes(1);
    expect(s.setPaused).toHaveBeenCalledWith(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)));
    expect(await s.episode(1)).toMatchObject({ status: "failed", errorCode: "limit" });
    expect(s.h.streams).toHaveLength(1);
    expect(lastFinish(s.finish)).toMatchObject({ usage: null, cost: 0 });
  });

  it("credit_exhausted(402) → nextCycleStart(지금, 주기 기준일)까지 정지, failed(limit)", async () => {
    const s = await setup(() => ({ status: 402, error: { type: "billing_error", message: "Your credit balance is too low" } }));
    await s.run(1);
    expect(s.setPaused).toHaveBeenCalledWith(nextCycleStart(new Date(), CYCLE_ANCHOR_DAY));
    expect(await s.episode(1)).toMatchObject({ status: "failed", errorCode: "limit" });
    expect(s.h.streams).toHaveLength(1);
  });

  it("retryable(5xx)이고 응답 전·60초 안이면 같은 함수에서 1번만 다시 한다", async () => {
    const s = await setup((n, call) => (call === 1 ? { status: 503, error: { type: "api_error", message: "unavailable" } } : ok(n)));
    await s.run(1);
    expect(s.h.streams).toHaveLength(2);
    expect((await s.episode(1)).status).toBe("done");
  });

  it("60초가 지난 뒤의 retryable이나 fatal은 다시 하지 않는다", async () => {
    const late = await setup(() => {
      // 첫 시도가 61초 뒤에 실패한 것처럼
      late.h.state.skew = 61_000;
      return { status: 529, error: { type: "overloaded_error", message: "Overloaded" } };
    });
    await late.run(1);
    expect(late.h.streams).toHaveLength(1);
    expect(await late.episode(1)).toMatchObject({ status: "failed", errorCode: "retryable" });

    const fatal = await setup(() => ({ status: 400, error: { type: "invalid_request_error", message: "bad" } }));
    await fatal.run(1);
    expect(fatal.h.streams).toHaveLength(1);
    expect(await fatal.episode(1)).toMatchObject({ status: "failed", errorCode: "fatal" });
  });

  it("응답 모델이 요청 모델과 다르면 fallback_on_writer를 기록하고 실제 모델로 원가를 센다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup((n) => whole(JSON.stringify(episodeJson(n)), { model: "claude-opus-4-8" }));
    await s.run(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/fallback_on_writer/);
    const finish = lastFinish(s.finish);
    expect(finish).toMatchObject({ status: "done", model: "claude-opus-4-8" });
    expect(finish.cost).toBe(estimateCostUsd(finish.usage as never, "claude-opus-4-8"));
  });

  it("n>1은 DB의 앞 편 헤드라인을 이어진 편까지만 넣는다", async () => {
    const s = await setup((n) => (n === 2 ? { status: 400, error: { type: "invalid_request_error", message: "bad" } } : ok(n)));
    for (const n of [1, 2, 3, 4] as const) await s.run(n);
    const system = (n: number) => String(s.h.streams.find((x) => x.n === n)!.body.messages[1].content);
    expect(system(1)).toContain("- 없음(첫 편)");
    expect(system(2)).toContain("앞 편 헤드라인:\n- 1편: 1편 헤드라인");
    // 2편이 실패해 헤드라인이 없으니 1편까지만. 3편 헤드라인을 2편 자리에 넣지 않는다
    expect(system(4)).toMatch(/앞 편 헤드라인:\n- 1편: 1편 헤드라인$/);
    expect(system(4)).not.toContain("3편 헤드라인");
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
    expect(await s.h.repo.startEpisode(s.id, 1)).toBe(true);
    const done = runEpisodeJob(s.job, { id: s.id, n: 1, payload: s.payload });
    await until(() => s.h.streams.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    await vi.advanceTimersByTimeAsync(NOTES_FLUSH_MS);
    expect(await s.episode(1)).toMatchObject({ status: "running", progress: [{ range: "10-01~10-03", note: "저녁마다 이야기했다" }] });
    release();
    await done;
    expect((await s.episode(1)).status).toBe("done");
  });

  it("예상 못 한 오류는 failed(internal)로 남기고 던지지 않는다", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = await setup(ok);
    vi.spyOn(s.h.repo, "getConversation").mockRejectedValueOnce(new Error("[repo] getConversation 실패 (XX000)"));
    await s.run(2);
    expect(lastFinish(s.finish)).toMatchObject({ n: 2, status: "failed", errorCode: "internal", usage: null });
    expect(s.h.streams).toHaveLength(0);
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe("1편 응답 시작과 dispatchRest", () => {
  it("1편이 응답을 시작하면 queued인 2~4편만 띄운다", async () => {
    const s = await setup(ok);
    await s.h.repo.finishEpisode({
      id: s.id,
      n: 3,
      status: "done",
      content: null,
      model: null,
      stopReason: null,
      errorCode: null,
      usage: null,
      cost: 0,
    });
    await s.run(1);
    expect(s.h.internal.map((c) => c.body.n).sort()).toEqual([2, 4]);
  });

  it("편마다 baseUrl의 내부 라우트로 서명한 POST를 보낸다(우회 헤더·10초 timeout 포함)", async () => {
    const inits: RequestInit[] = [];
    const s = await setup(ok, {
      internal: async (_url, init) => {
        inits.push(init);
        return new Response(null, { status: 202 });
      },
    });
    await dispatchRest({ ...s.job, baseHeaders: { "x-vercel-protection-bypass": "bypass" } }, { id: s.id, payload: s.payload, ns: [2, 3, 4] });
    expect(s.h.internal.map((c) => c.url)).toEqual(Array(3).fill(`${BASE}/api/internal/episodes`));
    for (const call of s.h.internal) {
      expect(call.headers.get("x-vercel-protection-bypass")).toBe("bypass");
      expect(call.headers.get("content-type")).toBe("application/json");
      const body = { id: s.id, n: call.body.n, payloadSha256: s.payloadSha256 };
      expect(verifyInternal(call.headers.get("x-analytalk-signature"), body, Date.now(), SECRETS.internal)).toBe(true);
      expect(call.body).toEqual({ id: s.id, n: call.body.n, payload: s.payload });
    }
    expect(inits.every((i) => i.method === "POST" && i.signal instanceof AbortSignal)).toBe(true);
    expect(s.finish).not.toHaveBeenCalled();
  });

  it("202가 아니거나(200 포함) fetch가 거부되면 그 편만 failed(dispatch)", async () => {
    const s = await setup(ok, {
      internal: async (_url, init) => {
        const { n } = JSON.parse(String(init.body));
        if (n === 2) return new Response(null, { status: 401 });
        if (n === 3) throw new TypeError("fetch failed");
        return new Response("ok", { status: 200 });
      },
    });
    await dispatchRest(s.job, { id: s.id, payload: s.payload, ns: [2, 3] });
    expect(await s.episode(2)).toMatchObject({ status: "failed", errorCode: "dispatch" });
    expect(await s.episode(3)).toMatchObject({ status: "failed", errorCode: "dispatch" });
    expect((await s.episode(4)).status).toBe("queued");
    await dispatchRest(s.job, { id: s.id, payload: s.payload, ns: [4] });
    expect(await s.episode(4)).toMatchObject({ status: "failed", errorCode: "dispatch" });
  });
});

describe("signInternal·verifyInternal", () => {
  const body = { id: "0b6c3f1e-2a4d-4c5b-9e8f-7a6b5c4d3e2f", n: 2, payloadSha256: "a".repeat(64) };
  const NOW = 1_800_000_000_000;
  const secret = SECRETS.internal;

  it("같은 본문·secret·60초 안이면 통과", () => {
    const header = signInternal(body, NOW, secret);
    expect(verifyInternal(header, body, NOW, secret)).toBe(true);
    expect(verifyInternal(header, body, NOW + 60_000, secret)).toBe(true);
    expect(verifyInternal(header, body, NOW - 60_000, secret)).toBe(true);
  });

  it("60초를 넘거나, 본문·secret이 다르거나, 헤더가 없거나 틀리면 거부", () => {
    const header = signInternal(body, NOW, secret);
    expect(verifyInternal(header, body, NOW + 60_001, secret)).toBe(false);
    expect(verifyInternal(header, body, NOW - 60_001, secret)).toBe(false);
    expect(verifyInternal(header, { ...body, n: 3 }, NOW, secret)).toBe(false);
    expect(verifyInternal(header, { ...body, id: `${body.id.slice(0, -1)}0` }, NOW, secret)).toBe(false);
    expect(verifyInternal(header, { ...body, payloadSha256: "b".repeat(64) }, NOW, secret)).toBe(false);
    expect(verifyInternal(header, body, NOW, `${secret}x`)).toBe(false);
    expect(verifyInternal(null, body, NOW, secret)).toBe(false);
    expect(verifyInternal("", body, NOW, secret)).toBe(false);
    expect(verifyInternal(`${header}x`, body, NOW, secret)).toBe(false);
    expect(verifyInternal(header.replace(/^\d+/, String(NOW + 1)), body, NOW, secret)).toBe(false);
  });

  it("secret이 비면 서명은 던지고 확인은 거부한다", () => {
    expect(() => signInternal(body, NOW, "")).toThrow();
    expect(verifyInternal(signInternal(body, NOW, secret), body, NOW, "")).toBe(false);
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
