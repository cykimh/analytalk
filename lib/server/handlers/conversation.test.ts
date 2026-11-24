import { describe, expect, it } from "vitest";
import { harness, makePayload, request } from "@/test/generation";
import { handleDeleteConversation, handleGetConversation } from "./conversation";
import { handleCreateConversation } from "./conversations";

async function created() {
  const h = await harness();
  const payload = makePayload();
  const res = await handleCreateConversation(request("POST", "/api/conversations", h.cookie, payload), h.deps);
  await h.settle();
  return { h, payload, id: (res.body as { id: string }).id };
}

const get = (cookie: string | null, id: string) => request("GET", `/api/conversations/${id}`, cookie);
const del = (cookie: string | null, id: string) => request("DELETE", `/api/conversations/${id}`, cookie);

describe("GET /api/conversations/[id]", () => {
  it("같은 invite면 대화 정보와 편 4개(n·status·content·errorCode)", async () => {
    const { h, payload, id } = await created();
    const res = await handleGetConversation(get(h.cookie, id), h.deps, id);
    expect(res.status).toBe(200);
    expect(res.headers).toEqual({ "cache-control": "no-store" });
    const row = await h.repo.getConversation(id);
    expect(res.body).toEqual({
      concept: "couple",
      kind: "pair",
      displayNames: payload.members,
      stats: payload.stats,
      cutoffAt: row!.cutoffAt,
      msgSent: payload.msgSent,
      expiresAt: row!.expiresAt,
      shareScope: null,
      shareHidden: [],
      episodes: row!.episodes.map(({ n, status, content, errorCode }) => ({ n, status, content, errorCode })),
    });
    const episodes = (res.body as { episodes: { status: string; content: unknown }[] }).episodes;
    expect(episodes.map((e) => e.status)).toEqual(["done", "done", "done", "done"]);
    expect(episodes.every((e) => e.content !== null)).toBe(true);
  });

  it("다른 invite·없는 id는 404, 쿠키가 없으면 401", async () => {
    const { h, id } = await created();
    expect((await handleGetConversation(get(h.otherCookie, id), h.deps, id)).status).toBe(404);
    expect((await handleGetConversation(get(h.cookie, "nope"), h.deps, "nope")).status).toBe(404);
    expect((await handleGetConversation(get(null, id), h.deps, id)).status).toBe(401);
  });
});

describe("DELETE /api/conversations/[id]", () => {
  it("다른 invite는 404이고 지우지 않는다", async () => {
    const { h, id } = await created();
    expect((await handleDeleteConversation(del(h.otherCookie, id), h.deps, id)).status).toBe(404);
    expect(await h.repo.getConversation(id)).not.toBeNull();
    expect((await handleDeleteConversation(del(null, id), h.deps, id)).status).toBe(401);
  });

  it("같은 invite면 204. 그 뒤 GET은 404", async () => {
    const { h, id } = await created();
    expect(await handleDeleteConversation(del(h.cookie, id), h.deps, id)).toEqual({ status: 204, body: undefined });
    expect(await h.repo.getConversation(id)).toBeNull();
    expect((await handleGetConversation(get(h.cookie, id), h.deps, id)).status).toBe(404);
    expect((await handleDeleteConversation(del(h.cookie, id), h.deps, id)).status).toBe(404);
  });
});
