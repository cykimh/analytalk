import { describe, expect, it } from "vitest";
import { harness, makePayload, request } from "@/test/generation";
import { handleDeleteConversation, handleGetConversation } from "./conversation";
import { handleCreateConversation } from "./conversations";
import { handleCreateShare, handleRevokeShare } from "./shares";

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
      shared: false,
      shareScope: null,
      shareHidden: [],
      episodes: row!.episodes.map(({ n, status, content, errorCode }) => ({ n, status, content, errorCode })),
    });
    const episodes = (res.body as { episodes: { status: string; content: unknown }[] }).episodes;
    expect(episodes.map((e) => e.status)).toEqual(["done", "done", "done", "done"]);
    expect(episodes.every((e) => e.content !== null)).toBe(true);
  });

  it("shared는 링크가 살아 있는지만 알린다: 공유 전 false, POST 뒤 true, DELETE 뒤 false. 토큰 해시는 내보내지 않는다", async () => {
    const { h, id } = await created();
    const read = async () => (await handleGetConversation(get(h.cookie, id), h.deps, id)).body as Record<string, unknown>;
    expect((await read()).shared).toBe(false);

    const res = await handleCreateShare(request("POST", "/api/shares", h.cookie, { id, scope: "all", hidden: [3] }), h.deps);
    expect(res.status).toBe(200);
    const after = await read();
    expect([after.shared, after.shareScope, after.shareHidden]).toEqual([true, "all", [3]]);
    const hash = (await h.repo.getConversation(id))!.shareTokenHash!;
    expect(after).not.toHaveProperty("shareTokenHash");
    expect(JSON.stringify(after)).not.toContain(hash);

    expect((await handleRevokeShare(request("DELETE", "/api/shares", h.cookie, { id }), h.deps)).status).toBe(204);
    const revoked = await read();
    // 폐기해도 범위·숨김 설정은 남는다
    expect([revoked.shared, revoked.shareScope, revoked.shareHidden]).toEqual([false, "all", [3]]);
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
