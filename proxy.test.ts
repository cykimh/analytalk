import { getRedirectUrl, unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE } from "@/lib/config";
import { signSession } from "@/lib/invite/session";
import { routeConfig } from "@/lib/server/env";
import { config, proxy } from "./proxy";

const ORIGIN = "http://localhost:3200";
const SECRET = "proxy-test-session-secret";

const prodCsp = (n: string) =>
  `default-src 'self'; script-src 'self' 'nonce-${n}' 'strict-dynamic' https://challenges.cloudflare.com; ` +
  "style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; connect-src 'self'; img-src 'self' blob: data:; " +
  "frame-src https://challenges.cloudflare.com; base-uri 'none'; object-src 'none'; form-action 'self'";

beforeEach(() => {
  vi.stubEnv("ANALYTALK_E2E", "");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("SESSION_SECRET", SECRET);
});
afterEach(() => vi.unstubAllEnvs());

function request(path: string, cookie?: string): NextRequest {
  return new NextRequest(new URL(path, ORIGIN), { headers: cookie === undefined ? {} : { cookie: `${SESSION_COOKIE}=${cookie}` } });
}

const validCookie = (secret = SECRET) => signSession("invite-1", Date.now() + 60_000, secret);
const nonceOf = (csp: string | null) => /'nonce-([^']+)'/.exec(csp ?? "")?.[1];

/** NextResponse.next({ request: { headers } })가 렌더로 넘기는 요청 헤더 */
const forwarded = (res: Response, name: string) => res.headers.get(`x-middleware-request-${name}`);

describe("proxy CSP", () => {
  it("요청마다 새 nonce로 CSP를 응답에 걸고, 같은 값을 x-nonce·CSP 요청 헤더로 렌더에 넘긴다", () => {
    const res = proxy(request("/"));
    const csp = res.headers.get("content-security-policy");
    const nonce = nonceOf(csp)!;
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22,}={0,2}$/);
    expect(csp).toBe(prodCsp(nonce));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(forwarded(res, "x-nonce")).toBe(nonce);
    expect(forwarded(res, "content-security-policy")).toBe(csp);

    const again = nonceOf(proxy(request("/")).headers.get("content-security-policy"));
    expect(again).not.toBe(nonce);
  });

  it("개발 서버에서만 script-src에 'unsafe-eval'을 더한다", () => {
    expect(proxy(request("/")).headers.get("content-security-policy")).not.toContain("'unsafe-eval'");
    vi.stubEnv("NODE_ENV", "development");
    const csp = proxy(request("/")).headers.get("content-security-policy")!;
    expect(csp).toContain(`'nonce-${nonceOf(csp)}' 'strict-dynamic' https://challenges.cloudflare.com 'unsafe-eval';`);
  });
});

describe("proxy 초대 게이트", () => {
  it.each(["/new", "/c/x", "/c/abc/report"])("쿠키가 없으면 %s를 /로 보낸다", (path) => {
    const res = proxy(request(path));
    expect(res.status).toBe(307);
    expect(getRedirectUrl(res)).toBe(`${ORIGIN}/`);
  });

  it("서명이 틀리거나, 다른 secret으로 서명했거나, 만료됐거나, 모양이 틀린 쿠키도 /로 보낸다", () => {
    const valid = validCookie();
    const bad = [
      `${valid.slice(0, -2)}xx`,
      validCookie("other-secret"),
      signSession("invite-1", Date.now() - 1, SECRET),
      "garbage",
      "",
    ];
    for (const cookie of bad) expect(getRedirectUrl(proxy(request("/new", cookie)))).toBe(`${ORIGIN}/`);
  });

  it("서명이 맞으면 통과시킨다(폐기 여부는 API·페이지가 확인한다)", () => {
    for (const path of ["/new", "/c/abc/report"]) {
      const res = proxy(request(path, validCookie()));
      expect(getRedirectUrl(res)).toBeNull();
      expect(res.headers.get("x-middleware-next")).toBe("1");
      expect(nonceOf(res.headers.get("content-security-policy"))).toBeTruthy();
    }
  });

  it("프로덕션에 SESSION_SECRET이 없으면 어떤 쿠키도 통과시키지 않는다", () => {
    const cookie = validCookie();
    vi.stubEnv("SESSION_SECRET", "");
    expect(getRedirectUrl(proxy(request("/new", cookie)))).toBe(`${ORIGIN}/`);
  });

  it("E2E 모드에서는 API와 같은 고정 테스트 secret으로 확인한다", () => {
    vi.stubEnv("ANALYTALK_E2E", "1");
    vi.stubEnv("VERCEL", "");
    const cookie = validCookie(routeConfig().secrets.session);
    expect(getRedirectUrl(proxy(request("/new", cookie)))).toBeNull();
    expect(getRedirectUrl(proxy(request("/new", validCookie())))).toBe(`${ORIGIN}/`);
  });

  it.each(["/", "/about", "/demo", "/s/token", "/api/conversations", "/news", "/cx", "/newx", "/demo/x"])("쿠키 없이도 %s는 막지 않는다", (path) => {
    const res = proxy(request(path));
    expect(getRedirectUrl(res)).toBeNull();
    expect(nonceOf(res.headers.get("content-security-policy"))).toBeTruthy();
  });
});

describe("proxy matcher", () => {
  const matches = (path: string) => unstable_doesMiddlewareMatch({ config, url: `${ORIGIN}${path}` });

  it("정적 파일은 건너뛴다", () => {
    for (const path of ["/_next/static/chunks/main.js", "/_next/image?url=%2Fog%2Fgroup.png&w=640&q=75", "/favicon.ico", "/og/couple.png"]) {
      expect(matches(path), path).toBe(false);
    }
  });

  it("페이지와 API는 모두 지난다", () => {
    for (const path of ["/", "/new", "/c/x", "/c/x/report", "/s/token", "/about", "/demo", "/api/conversations", "/api/health"]) {
      expect(matches(path), path).toBe(true);
    }
  });
});
