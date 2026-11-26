import { describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, SESSION_TTL_DAYS } from "@/lib/config";
import { hashCode } from "@/lib/invite/code";
import { readCookie, signSession, verifySession } from "@/lib/invite/session";
import { memoryRepo } from "@/lib/server/repo";
import type { HandlerDeps } from "@/lib/server/route";
import { handleInvite, requireInvite } from "./invite";

const NOW = 1_800_000_000_000;
const SECRET = "test-session-secret-0123456789abcdef";
const GOOD = "GOOD234567";
const GONE = "GONE234567";

function makeDeps(over: Partial<HandlerDeps> = {}, siteverify: unknown = { success: true, action: "invite" }) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(siteverify));
  const deps: HandlerDeps = {
    repo: memoryRepo({ invites: [{ code: GOOD, monthlyLimit: 2 }, { code: GONE, monthlyLimit: 2, revoked: true }] }),
    client: null,
    schedule: () => {},
    deadlineAt: () => Number.POSITIVE_INFINITY,
    now: () => NOW,
    fetch,
    secrets: { session: SECRET, turnstile: "ts-secret" },
    production: true,
    ...over,
  };
  return { deps, fetch };
}

const post = (body: unknown) =>
  new Request("https://analytalk.example.com/api/invite", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "1.2.3.4, 10.0.0.1" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const withCookie = (cookie: string | null) =>
  new Request("https://analytalk.example.com/api/conversations", { headers: cookie ? { cookie } : {} });

describe("handleInvite", () => {
  it("맞는 코드: 200 + 30일 세션 쿠키(HttpOnly·SameSite=Lax, 프로덕션은 Secure)", async () => {
    const { deps } = makeDeps();
    const res = await handleInvite(post({ code: GOOD, turnstileToken: "tok" }), deps);
    expect(res.status).toBe(200);
    const cookie = res.headers?.["set-cookie"] ?? "";
    const parts = cookie.split("; ");
    expect(parts).toEqual(expect.arrayContaining(["HttpOnly", "SameSite=Lax", "Secure", "Path=/"]));
    const invite = await deps.repo.findInvite(hashCode(GOOD));
    expect(verifySession(readCookie(cookie, SESSION_COOKIE), SECRET, NOW)).toEqual({ inviteId: invite!.id });
    expect(verifySession(readCookie(cookie, SESSION_COOKIE), SECRET, NOW + SESSION_TTL_DAYS * 86_400_000)).toBeNull();
  });

  it("코드는 대소문자·앞뒤 공백을 가리지 않는다", async () => {
    const { deps } = makeDeps();
    expect((await handleInvite(post({ code: ` ${GOOD.toLowerCase()} `, turnstileToken: "tok" }), deps)).status).toBe(200);
  });

  it("Turnstile에 토큰·첫 번째 IP·action invite를 보낸다", async () => {
    const { deps, fetch } = makeDeps();
    await handleInvite(post({ code: GOOD, turnstileToken: "tok" }), deps);
    const form = new URLSearchParams(fetch.mock.calls[0][1]?.body as URLSearchParams);
    expect(form.get("response")).toBe("tok");
    expect(form.get("remoteip")).toBe("1.2.3.4");
  });

  it.each([
    ["틀린 코드", "WRONG23456"],
    ["폐기된 코드", GONE],
  ])("%s: 401, 쿠키 없음", async (_label, code) => {
    const { deps } = makeDeps();
    const res = await handleInvite(post({ code, turnstileToken: "tok" }), deps);
    expect(res.status).toBe(401);
    expect(res.headers?.["set-cookie"]).toBeUndefined();
  });

  it("Turnstile fail: 403", async () => {
    const { deps } = makeDeps({}, { success: true, action: "login" });
    expect((await handleInvite(post({ code: GOOD, turnstileToken: "tok" }), deps)).status).toBe(403);
  });

  it("토큰이 없으면 Turnstile fail로 본다: 403", async () => {
    const { deps, fetch } = makeDeps();
    expect((await handleInvite(post({ code: GOOD }), deps)).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("프로덕션에서 Turnstile secret이 없으면 503", async () => {
    const { deps } = makeDeps({ secrets: { session: SECRET } });
    expect((await handleInvite(post({ code: GOOD, turnstileToken: "tok" }), deps)).status).toBe(503);
  });

  it("프로덕션에서 세션 secret이 없으면 503", async () => {
    const { deps } = makeDeps({ secrets: { session: "", turnstile: "ts-secret" } });
    expect((await handleInvite(post({ code: GOOD, turnstileToken: "tok" }), deps)).status).toBe(503);
  });

  it("개발에서 Turnstile secret이 없으면 확인 없이 통과하고 쿠키에 Secure가 없다", async () => {
    const { deps, fetch } = makeDeps({ production: false, secrets: { session: SECRET } });
    const res = await handleInvite(post({ code: GOOD, turnstileToken: "x" }), deps);
    expect(res.status).toBe(200);
    expect(res.headers?.["set-cookie"]?.split("; ")).not.toContain("Secure");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([["not json"], [{}], [{ code: "" }], [{ code: 123, turnstileToken: "tok" }], [{ code: "A".repeat(65) }]])(
    "본문이 틀리면 400: %j",
    async (body) => {
      const { deps } = makeDeps();
      expect((await handleInvite(post(body), deps)).status).toBe(400);
    },
  );
});

describe("requireInvite", () => {
  async function login() {
    const { deps } = makeDeps();
    const res = await handleInvite(post({ code: GOOD, turnstileToken: "tok" }), deps);
    return { deps, cookie: (res.headers?.["set-cookie"] ?? "").split(";")[0] };
  }

  it("로그인 쿠키면 inviteId", async () => {
    const { deps, cookie } = await login();
    const invite = await deps.repo.findInvite(hashCode(GOOD));
    expect(await requireInvite(withCookie(`a=1; ${cookie}`), deps)).toEqual({ inviteId: invite!.id });
  });

  it("쿠키가 없거나 만료되면 401", async () => {
    const { deps, cookie } = await login();
    expect(await requireInvite(withCookie(null), deps)).toEqual({ status: 401 });
    const later = { ...deps, now: () => NOW + SESSION_TTL_DAYS * 86_400_000 };
    expect(await requireInvite(withCookie(cookie), later)).toEqual({ status: 401 });
  });

  it("폐기된 코드의 쿠키는 401", async () => {
    const { deps } = makeDeps();
    const gone = await deps.repo.findInvite(hashCode(GONE));
    const cookie = `${SESSION_COOKIE}=${signSession(gone!.id, NOW + 60_000, SECRET)}`;
    expect(await requireInvite(withCookie(cookie), deps)).toEqual({ status: 401 });
  });

  it("서명이 맞아도 없는 코드면 401", async () => {
    const { deps } = makeDeps();
    const cookie = `${SESSION_COOKIE}=${signSession("0b6c3f1e-2a4d-4c5b-9e8f-7a6b5c4d3e2f", NOW + 60_000, SECRET)}`;
    expect(await requireInvite(withCookie(cookie), deps)).toEqual({ status: 401 });
  });

  it("다른 secret으로 서명한 쿠키는 401", async () => {
    const { deps, cookie } = await login();
    expect(await requireInvite(withCookie(cookie), { ...deps, secrets: { ...deps.secrets, session: `${SECRET}x` } })).toEqual({
      status: 401,
    });
  });
});
