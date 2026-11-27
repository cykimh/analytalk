import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => vi.restoreAllMocks());

const post = (cookie: string | null, body: unknown) => request("POST", "/api/shares", cookie, body);
const del = (cookie: string | null, body: unknown) => request("DELETE", "/api/shares", cookie, body);
const tokenOf = (url: string) => url.split("/s/")[1];
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function shared() {
  const c = await created();
  const res = await handleCreateShare(post(c.h.cookie, { id: c.id }), c.h.deps);
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
  });

  it("옛 본문(scope·hidden 포함)도 받는다", async () => {
    const { h, id } = await created();
    const res = await handleCreateShare(post(h.cookie, { id, scope: "first", hidden: [1, 9] }), h.deps);
    expect(res).toMatchObject({ status: 200, body: { shared: true } });
    expect(await loadSharedView(h.repo, tokenOf((res.body as { url: string }).url))).not.toBeNull();
  });

  it("응답은 캐시하지 않는다", async () => {
    const { res } = await shared();
    expect(res.headers).toEqual({ "cache-control": "no-store" });
  });

  it("다른 invite는 404이고 공유되지 않는다. 쿠키가 없으면 401, 잘못된 본문은 400", async () => {
    const { h, id } = await created();
    expect((await handleCreateShare(post(h.otherCookie, { id }), h.deps)).status).toBe(404);
    expect((await h.repo.getConversation(id))!.shareTokenHash).toBeNull();
    expect((await handleCreateShare(post(null, { id }), h.deps)).status).toBe(401);
    expect((await handleCreateShare(post(h.cookie, {}), h.deps)).status).toBe(400);
    expect((await handleCreateShare(post(h.cookie, { id: "" }), h.deps)).status).toBe(400);
  });

  it("이미 공유 중이면 쓰지 않는다: url은 null, 토큰 그대로, setShare 0번", async () => {
    const { h, id, token } = await shared();
    const setShare = vi.spyOn(h.repo, "setShare");
    const res = await handleCreateShare(post(h.cookie, { id }), h.deps);
    expect(res).toEqual({ status: 200, body: { url: null, shared: true }, headers: { "cache-control": "no-store" } });
    expect(setShare).not.toHaveBeenCalled();
    expect((await h.repo.getConversation(id))!.shareTokenHash).toBe(sha(token));
    expect(await loadSharedView(h.repo, token)).not.toBeNull();
  });

  it("폐기한 뒤 다시 공유하면 새 토큰이 나온다", async () => {
    const { h, id, token } = await shared();
    await handleRevokeShare(del(h.cookie, { id }), h.deps);
    const res = await handleCreateShare(post(h.cookie, { id }), h.deps);
    const next = tokenOf((res.body as { url: string }).url);
    expect(next).not.toBe(token);
    expect(await loadSharedView(h.repo, token)).toBeNull();
    expect(await loadSharedView(h.repo, next)).not.toBeNull();
  });
});

describe("POST/DELETE 동시 요청", () => {
  it("공유 중인 대화의 POST가 읽은 뒤 폐기와 겹쳐도 쓰지 않으므로 폐기가 살아 있다", async () => {
    const { h, id, token } = await shared();
    const real = h.deps.repo.getConversation.bind(h.deps.repo);
    let first = true;
    h.deps.repo.getConversation = async (cid: string) => {
      const row = await real(cid);
      if (first) {
        first = false;
        await handleRevokeShare(del(h.cookie, { id }), h.deps);
      }
      return row;
    };
    const res = await handleCreateShare(post(h.cookie, { id }), h.deps);
    expect(res).toMatchObject({ status: 200, body: { url: null } });
    expect(await loadSharedView(h.repo, token)).toBeNull();
    expect((await real(id))!.shareTokenHash).toBeNull();
  });

  it("미공유 대화에 겹친 두 POST는 하나만 토큰을 얻고 다른 하나는 409다", async () => {
    const c = await created();
    const real = c.h.deps.repo.getConversation.bind(c.h.deps.repo);
    let nested = false;
    c.h.deps.repo.getConversation = async (cid: string) => {
      const row = await real(cid);
      if (!nested) {
        nested = true;
        const inner = await handleCreateShare(post(c.h.cookie, { id: c.id }), c.h.deps);
        expect(inner.status).toBe(200);
      }
      return row;
    };
    const res = await handleCreateShare(post(c.h.cookie, { id: c.id }), c.h.deps);
    expect(res.status).toBe(409);
    expect((await real(c.id))!.shareTokenHash).not.toBeNull();
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
  it("공유 중이면 리포트 한 편과 컨셉·tone을 보여 준다", async () => {
    const { h, id, token } = await shared();
    const view = await loadSharedView(h.repo, token);
    expect(view!.report).toEqual((await h.repo.getConversation(id))!.report.content);
    // 인트로 1 + 개인별 2(철수·민지) + 마무리 1
    expect(view!.report!.sections).toHaveLength(4);
    expect([view!.concept, view!.tone]).toEqual(["couple", "fact"]);
  });

  it("리포트 내용이 없으면(쓰는 중·실패) report는 null", async () => {
    const h = await harness();
    h.state.manual = true;
    const res = await handleCreateConversation(request("POST", "/api/conversations", h.cookie, makePayload()), h.deps);
    const share = await handleCreateShare(post(h.cookie, { id: (res.body as { id: string }).id }), h.deps);
    const view = await loadSharedView(h.repo, tokenOf((share.body as { url: string }).url));
    expect(view).not.toBeNull();
    expect(view!.report).toBeNull();
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

  it("원문 대화·앵커·토큰 해시 같은 열은 넘기지 않는다(컨셉·tone·표시 이름·통계·리포트 내용만)", async () => {
    const { h, token } = await shared();
    const view = await loadSharedView(h.repo, token);
    expect(Object.keys(view!).sort()).toEqual(["concept", "displayNames", "report", "stats", "tone"]);
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
