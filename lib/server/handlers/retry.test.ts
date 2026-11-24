import { afterEach, describe, expect, it, vi } from "vitest";
import { cut, cutInSecondSection, episodeJson, harness, makePayload, request, whole } from "@/test/generation";
import { handleCreateConversation } from "./conversations";
import { handleRetry } from "./retry";
import { handleStatus } from "./status";

afterEach(() => vi.restoreAllMocks());

const retry = (cookie: string | null, body: unknown) => request("POST", "/api/episodes/retry", cookie, body);
const accepted = async () => new Response(null, { status: 202 });

async function statuses(h: Awaited<ReturnType<typeof harness>>, id: string) {
  const res = await handleStatus(request("GET", `/api/conversations/${id}/status`, h.cookie), h.deps, id);
  return (res.body as { episodes: { status: string; errorCode: string | null }[] }).episodes.map((e) => [e.status, e.errorCode]);
}

describe("POST /api/episodes/retry", () => {
  it("1편이 HTTP 503을 두 번 냄 → 1편 failed, 내부 fetch 0번, 2~4편 queued. retry(n=1)가 성공하면 그때 3번 (Review Focus 2)", async () => {
    const h = await harness({
      reply: (n, call) =>
        n === 1 && call <= 2 ? { status: 503, error: { type: "api_error", message: "unavailable" } } : whole(JSON.stringify(episodeJson(n))),
    });
    const payload = makePayload();
    const res = await handleCreateConversation(request("POST", "/api/conversations", h.cookie, payload), h.deps);
    await h.settle();
    const { id } = res.body as { id: string };
    expect(await statuses(h, id)).toEqual([
      ["failed", "retryable"],
      ["queued", null],
      ["queued", null],
      ["queued", null],
    ]);
    expect(h.streams.map((s) => s.n)).toEqual([1, 1]);
    expect(h.internal).toHaveLength(0);

    const again = await handleRetry(retry(h.cookie, { id, n: 1, payload }), h.deps);
    expect(again.status).toBe(202);
    await h.settle();
    expect(h.internal.map((c) => c.body.n).sort()).toEqual([2, 3, 4]);
    expect(await statuses(h, id)).toEqual(Array(4).fill(["done", null]));
  });

  it("partial 편을 동시에 두 번 다시 쓰면 하나는 202·running, 하나는 409", async () => {
    const h = await harness({ reply: (n) => cut(cutInSecondSection(n)), deadlineMs: 150, internal: accepted });
    const payload = makePayload();
    const res = await handleCreateConversation(request("POST", "/api/conversations", h.cookie, payload), h.deps);
    await h.settle();
    const { id } = res.body as { id: string };
    expect((await statuses(h, id))[0]).toEqual(["partial", null]);

    h.state.manual = true;
    const both = await Promise.all([
      handleRetry(retry(h.cookie, { id, n: 1, payload }), h.deps),
      handleRetry(retry(h.cookie, { id, n: 1, payload: JSON.parse(JSON.stringify(payload)) }), h.deps),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([202, 409]);
    expect((await statuses(h, id))[0]).toEqual(["running", null]);
    expect(h.queued).toHaveLength(1);
  });

  it("다른 invite·다른 payload·없는 대화·이미 done인 편은 409", async () => {
    // 2~4편은 dispatch 실패(failed)라 다시 쓸 수 있는 상태다
    const h = await harness({ internal: async () => new Response(null, { status: 401 }) });
    const payload = makePayload();
    const res = await handleCreateConversation(request("POST", "/api/conversations", h.cookie, payload), h.deps);
    await h.settle();
    const { id } = res.body as { id: string };
    h.state.manual = true;
    expect((await handleRetry(retry(h.otherCookie, { id, n: 2, payload }), h.deps)).status).toBe(409);
    expect((await handleRetry(retry(h.cookie, { id, n: 2, payload: makePayload(1) }), h.deps)).status).toBe(409);
    const missing = "0b6c3f1e-2a4d-4c5b-9e8f-7a6b5c4d3e2f";
    expect((await handleRetry(retry(h.cookie, { id: missing, n: 2, payload }), h.deps)).status).toBe(409);
    expect((await handleRetry(retry(h.cookie, { id, n: 1, payload }), h.deps)).status).toBe(409);
    expect(h.queued).toHaveLength(0);
    // 같은 코드·같은 payload면 받는다
    expect((await handleRetry(retry(h.cookie, { id, n: 2, payload }), h.deps)).status).toBe(202);
    expect(h.queued).toHaveLength(1);
  });

  it("정지 중이면 423: 편을 시작하지 않고 Anthropic을 부르지 않는다. 정지가 풀리면 받는다", async () => {
    const h = await harness({
      reply: (n, call) =>
        n === 1 && call <= 2 ? { status: 503, error: { type: "api_error", message: "unavailable" } } : whole(JSON.stringify(episodeJson(n))),
    });
    const payload = makePayload();
    const res = await handleCreateConversation(request("POST", "/api/conversations", h.cookie, payload), h.deps);
    await h.settle();
    const { id } = res.body as { id: string };
    expect((await statuses(h, id))[0]).toEqual(["failed", "retryable"]);

    await h.repo.setPaused(new Date(Date.now() + 3_600_000));
    const start = vi.spyOn(h.repo, "startEpisode");
    expect(await handleRetry(retry(h.cookie, { id, n: 1, payload }), h.deps)).toEqual({ status: 423, body: { error: "paused" } });
    await h.settle();
    expect(start).not.toHaveBeenCalled();
    expect((await statuses(h, id))[0]).toEqual(["failed", "retryable"]);
    expect(h.streams).toHaveLength(2);

    await h.repo.setPaused(new Date(Date.now() - 1));
    expect((await handleRetry(retry(h.cookie, { id, n: 1, payload }), h.deps)).status).toBe(202);
    await h.settle();
    expect(await statuses(h, id)).toEqual(Array(4).fill(["done", null]));
  });

  it("본문이 틀리면 400, 쿠키가 없으면 401, client가 없으면 503", async () => {
    const h = await harness();
    const payload = makePayload();
    const id = "0b6c3f1e-2a4d-4c5b-9e8f-7a6b5c4d3e2f";
    expect((await handleRetry(retry(h.cookie, { id, n: 5, payload }), h.deps)).status).toBe(400);
    expect((await handleRetry(retry(h.cookie, { id, payload }), h.deps)).status).toBe(400);
    expect((await handleRetry(retry(h.cookie, { id, n: 1, payload: { ...payload, transcript: "<x>" } }), h.deps)).status).toBe(400);
    expect((await handleRetry(retry(null, { id, n: 1, payload }), h.deps)).status).toBe(401);
    expect((await handleRetry(retry(h.cookie, { id, n: 1, payload }), { ...h.deps, client: null })).status).toBe(503);
  });
});
