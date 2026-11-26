import { afterEach, describe, expect, it, vi } from "vitest";
import { cut, cutInSecondSection, episodeJson, harness, makePayload, request, whole } from "@/test/generation";
import { handleCreateConversation } from "./conversations";
import { handleRetry } from "./retry";
import { handleStatus } from "./status";

afterEach(() => vi.restoreAllMocks());

const retry = (cookie: string | null, body: unknown) => request("POST", "/api/episodes/retry", cookie, body);
const unavailable = { status: 503, error: { type: "api_error", message: "unavailable" } };
const OTHER_ID = "0b6c3f1e-2a4d-4c5b-9e8f-7a6b5c4d3e2f";

async function reportOf(h: Awaited<ReturnType<typeof harness>>, id: string) {
  const res = await handleStatus(request("GET", `/api/conversations/${id}/status`, h.cookie), h.deps, id);
  const { status, errorCode } = (res.body as { report: { status: string; errorCode: string | null } }).report;
  return [status, errorCode];
}

/** 대화 하나를 만들고 리포트 작업이 끝날 때까지 기다린다 */
async function created(h: Awaited<ReturnType<typeof harness>>, payload = makePayload()) {
  const res = await handleCreateConversation(request("POST", "/api/conversations", h.cookie, payload), h.deps);
  await h.settle();
  return { payload, id: (res.body as { id: string }).id };
}

/** 다른 대화의 원가로 최근 7일 원가 합을 cost달러로 만든다 */
const spend = (h: Awaited<ReturnType<typeof harness>>, cost: number) =>
  h.repo.finishReport({
    id: OTHER_ID,
    status: "done",
    content: null,
    model: "claude-opus-5-5",
    stopReason: "end_turn",
    errorCode: null,
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    cost,
  });

describe("POST /api/episodes/retry", () => {
  it("리포트가 HTTP 503을 두 번 냄 → failed(retryable). retry가 202 → done, fetch 0번 (Review Focus 2)", async () => {
    const h = await harness({ reply: (n, call) => (call <= 2 ? unavailable : whole(JSON.stringify(episodeJson(n)))) });
    const { id, payload } = await created(h);
    expect(await reportOf(h, id)).toEqual(["failed", "retryable"]);
    expect(h.streams).toHaveLength(2);

    const again = await handleRetry(retry(h.cookie, { id, payload }), h.deps);
    expect(again.status).toBe(202);
    await h.settle();
    expect(await reportOf(h, id)).toEqual(["done", null]);
    expect(h.streams).toHaveLength(3);
    expect(h.fetches).toHaveLength(0);
  });

  it("옛 본문 {id, n, payload}도 받는다(n은 버린다)", async () => {
    const h = await harness({ reply: (n, call) => (call <= 2 ? unavailable : whole(JSON.stringify(episodeJson(n)))) });
    const { id, payload } = await created(h);
    expect((await handleRetry(retry(h.cookie, { id, n: 3, payload }), h.deps)).status).toBe(202);
    await h.settle();
    expect(await reportOf(h, id)).toEqual(["done", null]);
  });

  it("partial 리포트를 동시에 두 번 다시 쓰면 하나는 202·running, 하나는 409", async () => {
    const h = await harness({ reply: (n) => cut(cutInSecondSection(n)), deadlineMs: 150 });
    const { id, payload } = await created(h);
    expect(await reportOf(h, id)).toEqual(["partial", null]);

    h.state.manual = true;
    const both = await Promise.all([
      handleRetry(retry(h.cookie, { id, payload }), h.deps),
      handleRetry(retry(h.cookie, { id, payload: JSON.parse(JSON.stringify(payload)) }), h.deps),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([202, 409]);
    expect(await reportOf(h, id)).toEqual(["running", null]);
    expect(h.queued).toHaveLength(1);
  });

  it("다른 invite·다른 payload·없는 대화는 409 payload_mismatch, done 리포트는 409 not_startable", async () => {
    const h = await harness({ reply: () => ({ status: 400, error: { type: "invalid_request_error", message: "bad" } }) });
    const { id, payload } = await created(h);
    expect(await reportOf(h, id)).toEqual(["failed", "fatal"]);
    h.state.manual = true;
    expect(await handleRetry(retry(h.otherCookie, { id, payload }), h.deps)).toEqual({ status: 409, body: { error: "payload_mismatch" } });
    expect((await handleRetry(retry(h.cookie, { id, payload: makePayload(1) }), h.deps)).status).toBe(409);
    expect((await handleRetry(retry(h.cookie, { id: OTHER_ID, payload }), h.deps)).status).toBe(409);
    expect(h.queued).toHaveLength(0);
    // 같은 코드·같은 payload면 받는다
    expect((await handleRetry(retry(h.cookie, { id, payload }), h.deps)).status).toBe(202);
    expect(h.queued).toHaveLength(1);

    const done = await harness();
    const d = await created(done);
    expect(await handleRetry(retry(done.cookie, { id: d.id, payload: d.payload }), done.deps)).toEqual({
      status: 409,
      body: { error: "not_startable" },
    });
  });

  it("정지 중이면 423: 리포트를 시작하지 않고 Anthropic을 부르지 않는다. 정지가 풀리면 받는다", async () => {
    const h = await harness({ reply: (n, call) => (call <= 2 ? unavailable : whole(JSON.stringify(episodeJson(n)))) });
    const { id, payload } = await created(h);
    expect(await reportOf(h, id)).toEqual(["failed", "retryable"]);

    await h.repo.setPaused(new Date(Date.now() + 3_600_000));
    expect(await handleRetry(retry(h.cookie, { id, payload }), h.deps)).toEqual({ status: 423, body: { error: "paused" } });
    await h.settle();
    expect(h.queued).toHaveLength(0);
    expect(await reportOf(h, id)).toEqual(["failed", "retryable"]);
    expect(h.streams).toHaveLength(2);

    await h.repo.setPaused(new Date(Date.now() - 1));
    expect((await handleRetry(retry(h.cookie, { id, payload }), h.deps)).status).toBe(202);
    await h.settle();
    expect(await reportOf(h, id)).toEqual(["done", null]);
  });

  it("리포트의 유료 실행은 3번까지: 늘 partial로 끝나는 리포트를 계속 다시 쓰면 세 번째 다시 쓰기부터 429 retry_limit", async () => {
    const h = await harness({ reply: (n) => cut(cutInSecondSection(n)), deadlineMs: 150 });
    const { id, payload } = await created(h);
    for (let i = 0; i < 2; i++) {
      expect((await handleRetry(retry(h.cookie, { id, payload }), h.deps)).status).toBe(202);
      await h.settle();
      expect(await reportOf(h, id)).toEqual(["partial", null]);
    }
    expect(await handleRetry(retry(h.cookie, { id, payload }), h.deps)).toEqual({ status: 429, body: { reason: "retry_limit" } });
    await h.settle();
    expect(h.streams).toHaveLength(3);
    expect(await reportOf(h, id)).toEqual(["partial", null]);
  });

  it("주간 상한: 최근 7일 원가 + 이번 몫(평균 원가 전체 1.2)이 22.5를 넘으면 429 global_limit, 리포트를 시작하지 않는다", async () => {
    const h = await harness({ reply: (n, call) => (call <= 2 ? unavailable : whole(JSON.stringify(episodeJson(n)))) });
    const { id, payload } = await created(h);
    expect(await reportOf(h, id)).toEqual(["failed", "retryable"]);
    // 21.4 + 1.2 = 22.6 > 22.5
    await spend(h, 21.4);
    const streams = h.streams.length;
    expect(await handleRetry(retry(h.cookie, { id, payload }), h.deps)).toEqual({ status: 429, body: { reason: "global_limit" } });
    await h.settle();
    expect(h.streams).toHaveLength(streams);
    expect(await reportOf(h, id)).toEqual(["failed", "retryable"]);

    // 20.0 + 1.2 = 21.2 ≤ 22.5
    const ok = await harness({ reply: (n, call) => (call <= 2 ? unavailable : whole(JSON.stringify(episodeJson(n)))) });
    const c = await created(ok);
    await spend(ok, 20);
    expect((await handleRetry(retry(ok.cookie, { id: c.id, payload: c.payload }), ok.deps)).status).toBe(202);
  });

  it("partial 리포트의 다시 쓰기가 응답 전에 실패해도(529 두 번) 앞의 글은 남는다: partial·content 그대로, 오류 코드만 남긴다", async () => {
    const h = await harness({
      reply: (n, call) => (call === 1 ? cut(cutInSecondSection(n)) : { status: 529, error: { type: "overloaded_error", message: "busy" } }),
      deadlineMs: 150,
    });
    const { id, payload } = await created(h);
    const before = (await h.repo.getConversation(id))!.report;
    expect(before.status).toBe("partial");
    expect(before.content).not.toBeNull();

    expect((await handleRetry(retry(h.cookie, { id, payload }), h.deps)).status).toBe(202);
    await h.settle();
    const after = (await h.repo.getConversation(id))!.report;
    expect(after).toMatchObject({ status: "partial", errorCode: "retryable" });
    expect(after.content).toEqual(before.content);
  });

  it("본문이 틀리면 400, 쿠키가 없으면 401, client가 없으면 503", async () => {
    const h = await harness();
    const payload = makePayload();
    const id = OTHER_ID;
    expect((await handleRetry(retry(h.cookie, { id }), h.deps)).status).toBe(400);
    expect((await handleRetry(retry(h.cookie, { payload }), h.deps)).status).toBe(400);
    expect((await handleRetry(retry(h.cookie, { id: "", payload }), h.deps)).status).toBe(400);
    expect(await handleRetry(retry(h.cookie, { id, payload: { ...payload, transcript: "<x>" } }), h.deps)).toMatchObject({
      status: 400,
      body: { error: "bad_payload" },
    });
    expect((await handleRetry(retry(null, { id, payload }), h.deps)).status).toBe(401);
    expect((await handleRetry(retry(h.cookie, { id, payload }), { ...h.deps, client: null })).status).toBe(503);
  });
});
