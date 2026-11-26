import { describe, expect, it } from "vitest";
import { harness, makePayload, request } from "@/test/generation";
import { handleCreateConversation } from "./conversations";
import { handleStatus } from "./status";

const status = (cookie: string | null, id: string) => request("GET", `/api/conversations/${id}/status`, cookie);

describe("GET /api/conversations/[id]/status", () => {
  it("진행 중: 리포트의 status·progress·errorCode, 정지가 없으면 paused false", async () => {
    const h = await harness();
    h.state.manual = true;
    const res = await handleCreateConversation(request("POST", "/api/conversations", h.cookie, makePayload()), h.deps);
    const { id } = res.body as { id: string };
    await h.repo.saveProgress(id, [{ range: "10-01~10-03", note: "저녁마다" }]);
    const out = await handleStatus(status(h.cookie, id), h.deps, id);
    expect(out).toEqual({
      status: 200,
      body: {
        report: { status: "running", progress: [{ range: "10-01~10-03", note: "저녁마다" }], errorCode: null },
        paused: false,
      },
      headers: { "cache-control": "no-store" },
    });
    // 상태 조회는 Anthropic·fetch를 부르지 않는다
    expect(h.streams).toHaveLength(0);
    expect(h.fetches).toHaveLength(0);
  });

  it("paused는 전역 정지 상태(paused_until > 지금)다. 이 대화의 리포트 오류 코드와 상관없다", async () => {
    const h = await harness();
    h.state.manual = true;
    const res = await handleCreateConversation(request("POST", "/api/conversations", h.cookie, makePayload()), h.deps);
    const { id } = res.body as { id: string };
    const paused = async () => ((await handleStatus(status(h.cookie, id), h.deps, id)).body as { paused: boolean }).paused;

    // 다른 대화가 정지를 걸었다: 이 대화에는 limit 실패가 없어도 true
    await h.repo.setPaused(new Date(Date.now() + 3_600_000));
    expect(await paused()).toBe(true);

    // 이 대화의 리포트가 limit으로 실패했어도 정지가 풀리면 false(다시 쓰기를 막지 않는다)
    await h.repo.finishReport({ id, status: "failed", content: null, model: null, stopReason: null, errorCode: "limit", usage: null, cost: 0 });
    await h.repo.setPaused(new Date(Date.now() - 1));
    expect(await paused()).toBe(false);
  });

  it("다른 invite·없는 id는 404, 쿠키가 없으면 401", async () => {
    const h = await harness();
    const res = await handleCreateConversation(request("POST", "/api/conversations", h.cookie, makePayload()), h.deps);
    await h.settle();
    const { id } = res.body as { id: string };
    expect((await handleStatus(status(h.otherCookie, id), h.deps, id)).status).toBe(404);
    expect((await handleStatus(status(h.cookie, "nope"), h.deps, "nope")).status).toBe(404);
    expect((await handleStatus(status(null, id), h.deps, id)).status).toBe(401);
  });
});
