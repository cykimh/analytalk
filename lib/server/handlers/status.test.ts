import { describe, expect, it } from "vitest";
import { harness, makePayload, request } from "@/test/generation";
import { handleCreateConversation } from "./conversations";
import { handleStatus } from "./status";

const status = (cookie: string | null, id: string) => request("GET", `/api/conversations/${id}/status`, cookie);

describe("GET /api/conversations/[id]/status", () => {
  it("진행 중: 편마다 n·status·progress·errorCode, paused는 limit 실패가 없으면 false", async () => {
    const h = await harness();
    h.state.manual = true;
    const res = await handleCreateConversation(request("POST", "/api/conversations", h.cookie, makePayload()), h.deps);
    const { id } = res.body as { id: string };
    await h.repo.saveProgress(id, 1, [{ range: "10-01~10-03", note: "저녁마다" }]);
    const out = await handleStatus(status(h.cookie, id), h.deps, id);
    expect(out).toEqual({
      status: 200,
      body: {
        episodes: [
          { n: 1, status: "running", progress: [{ range: "10-01~10-03", note: "저녁마다" }], errorCode: null },
          { n: 2, status: "queued", progress: null, errorCode: null },
          { n: 3, status: "queued", progress: null, errorCode: null },
          { n: 4, status: "queued", progress: null, errorCode: null },
        ],
        paused: false,
      },
      headers: { "cache-control": "no-store" },
    });
    // 상태 조회는 Anthropic·내부 호출을 하지 않는다
    expect(h.streams).toHaveLength(0);
    expect(h.internal).toHaveLength(0);
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
