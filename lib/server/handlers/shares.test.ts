import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import nextConfig from "@/next.config";
import { harness, makePayload, request } from "@/test/generation";
import { handleCreateConversation } from "./conversations";
import { handleCreateShare, handleRevokeShare, loadSharedView } from "./shares";

async function created() {
  const h = await harness();
  const res = await handleCreateConversation(request("POST", "/api/conversations", h.cookie, makePayload()), h.deps);
  await h.settle();
  return { h, id: (res.body as { id: string }).id };
}

const post = (cookie: string | null, body: unknown) => request("POST", "/api/shares", cookie, body);
const del = (cookie: string | null, body: unknown) => request("DELETE", "/api/shares", cookie, body);
const tokenOf = (url: string) => url.split("/s/")[1];
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function shared(scope: "first" | "all" = "all", hidden: number[] = []) {
  const c = await created();
  const res = await handleCreateShare(post(c.h.cookie, { id: c.id, scope, hidden }), c.h.deps);
  return { ...c, res, token: tokenOf((res.body as { url: string }).url) };
}

describe("POST /api/shares", () => {
  it("토큰은 16바이트 base64url이고 DB에는 sha256만 있다", async () => {
    const { h, id, res, token } = await shared();
    expect(res.status).toBe(200);
    expect((res.body as { url: string }).url).toBe(`https://analytalk.example.com/s/${token}`);
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const row = await h.repo.getConversation(id);
    expect(row!.shareTokenHash).toBe(sha(token));
    expect(row!.shareTokenHash).not.toBe(token);
    expect(row!.shareScope).toBe("all");
  });

  it("응답은 캐시하지 않는다", async () => {
    const { res } = await shared();
    expect(res.headers).toEqual({ "cache-control": "no-store" });
  });

  it("다른 invite는 404이고 공유되지 않는다. 쿠키가 없으면 401, 잘못된 본문은 400", async () => {
    const { h, id } = await created();
    expect((await handleCreateShare(post(h.otherCookie, { id, scope: "all", hidden: [] }), h.deps)).status).toBe(404);
    expect((await h.repo.getConversation(id))!.shareTokenHash).toBeNull();
    expect((await handleCreateShare(post(null, { id, scope: "all", hidden: [] }), h.deps)).status).toBe(401);
    expect((await handleCreateShare(post(h.cookie, { id, scope: "some", hidden: [] }), h.deps)).status).toBe(400);
    expect((await handleCreateShare(post(h.cookie, { id, scope: "all", hidden: [5] }), h.deps)).status).toBe(400);
  });

  it("이미 공유 중이면 토큰은 그대로 두고 범위만 바꾼다(url은 null)", async () => {
    const { h, id, token } = await shared("all", []);
    const res = await handleCreateShare(post(h.cookie, { id, scope: "first", hidden: [2] }), h.deps);
    expect(res).toMatchObject({ status: 200, body: { url: null } });
    const row = await h.repo.getConversation(id);
    expect(row!.shareTokenHash).toBe(sha(token));
    expect([row!.shareScope, row!.shareHidden]).toEqual(["first", [2]]);
  });

  it("폐기한 뒤 다시 공유하면 새 토큰이 나온다", async () => {
    const { h, id, token } = await shared();
    await handleRevokeShare(del(h.cookie, { id }), h.deps);
    const res = await handleCreateShare(post(h.cookie, { id, scope: "all", hidden: [] }), h.deps);
    const next = tokenOf((res.body as { url: string }).url);
    expect(next).not.toBe(token);
    expect(await loadSharedView(h.repo, token)).toBeNull();
    expect(await loadSharedView(h.repo, next)).not.toBeNull();
  });
});

describe("DELETE /api/shares", () => {
  it("폐기 직후 공유 화면은 없다. 해시가 null이 된다", async () => {
    const { h, id, token } = await shared();
    expect(await loadSharedView(h.repo, token)).not.toBeNull();
    expect(await handleRevokeShare(del(h.cookie, { id }), h.deps)).toEqual({ status: 204, body: undefined });
    expect(await loadSharedView(h.repo, token)).toBeNull();
    expect((await h.repo.getConversation(id))!.shareTokenHash).toBeNull();
  });

  it("다른 invite는 404이고 폐기하지 않는다. 쿠키가 없으면 401", async () => {
    const { h, id, token } = await shared();
    expect((await handleRevokeShare(del(h.otherCookie, { id }), h.deps)).status).toBe(404);
    expect(await loadSharedView(h.repo, token)).not.toBeNull();
    expect((await handleRevokeShare(del(null, { id }), h.deps)).status).toBe(401);
  });
});

describe("공유 화면 읽기(loadSharedView)", () => {
  it("범위 all은 내용이 있는 편 4개를 보여 준다", async () => {
    const { h, token } = await shared("all");
    const view = await loadSharedView(h.repo, token);
    expect(view!.episodes.map((e) => e.n)).toEqual([1, 2, 3, 4]);
    expect(view!.concept).toBe("couple");
  });

  it("범위 first면 2편 이후가 없다", async () => {
    const { h, token } = await shared("first");
    expect((await loadSharedView(h.repo, token))!.episodes.map((e) => e.n)).toEqual([1]);
  });

  it("hidden을 [3]으로 바꾼 직후 3편이 없다", async () => {
    const { h, id, token } = await shared("all");
    await handleCreateShare(post(h.cookie, { id, scope: "all", hidden: [3] }), h.deps);
    expect((await loadSharedView(h.repo, token))!.episodes.map((e) => e.n)).toEqual([1, 2, 4]);
  });

  it("대화를 삭제하면 바로 없다", async () => {
    const { h, id, token } = await shared();
    await h.repo.deleteConversation(id, (await h.repo.getConversation(id))!.inviteId);
    expect(await loadSharedView(h.repo, token)).toBeNull();
  });

  it("만료된 대화는 없다", async () => {
    const { h, token } = await shared();
    const real = Date.now;
    Date.now = () => real() + 31 * 86_400_000;
    try {
      expect(await loadSharedView(h.repo, token)).toBeNull();
    } finally {
      Date.now = real;
    }
  });

  it("모양이 틀린 토큰은 저장소를 읽지 않고 없다", async () => {
    const { h } = await shared();
    expect(await loadSharedView(h.repo, "short")).toBeNull();
    expect(await loadSharedView(h.repo, "x".repeat(22))).toBeNull();
  });

  it("실제 이름·원문 대화·앵커 같은 열은 넘기지 않는다(표시 이름·통계·편 내용만)", async () => {
    const { h, token } = await shared();
    const view = await loadSharedView(h.repo, token);
    expect(Object.keys(view!).sort()).toEqual(["concept", "displayNames", "episodes", "stats"]);
    expect(Object.keys(view!.episodes[0]).sort()).toEqual(["content", "n"]);
  });
});

describe("next.config /s/* 헤더", () => {
  it("noindex와 no-referrer를 건다", async () => {
    const rules = await nextConfig.headers!();
    const rule = rules.find((r) => r.source === "/s/:path*");
    expect(rule).toBeDefined();
    const map = Object.fromEntries(rule!.headers.map((x) => [x.key, x.value]));
    expect(map["X-Robots-Tag"]).toBe("noindex");
    expect(map["Referrer-Policy"]).toBe("no-referrer");
  });
});
