// 모든 요청(정적 파일 제외)의 앞단.
// - 요청마다 nonce를 만들어 CSP(nonce + strict-dynamic)를 응답에 걸고, x-nonce·CSP 요청 헤더로 렌더에 넘긴다.
//   Next는 요청 CSP 헤더에서 nonce를 읽어 자기 스크립트에 붙인다. 그래서 모든 페이지는 동적 렌더다(app/layout.tsx)
// - 초대 게이트: 세션 쿠키가 없거나 서명이 틀리면 /new·/c/*를 /로 보낸다.
//   여기서는 서명·만료만 본다. 코드 폐기 여부는 API(requireInvite)와 페이지(hasInvite)가 DB로 확인한다
import { type NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/config";
import { verifySession } from "@/lib/invite/session";
import { routeConfig } from "@/lib/server/env";

const GATED = /^\/(?:new|c)(?:\/|$)/;

function contentSecurityPolicy(n: string, dev: boolean): string {
  // 개발 서버의 React는 오류 스택을 되살리려고 eval을 쓴다. 프로덕션에는 넣지 않는다
  return `
    default-src 'self';
    script-src 'self' 'nonce-${n}' 'strict-dynamic' https://challenges.cloudflare.com ${dev ? "'unsafe-eval'" : ""};
    style-src 'self' 'unsafe-inline';
    worker-src 'self' blob:;
    connect-src 'self';
    img-src 'self' blob: data:;
    frame-src https://challenges.cloudflare.com;
    base-uri 'none'; object-src 'none'; form-action 'self'
  `
    .replace(/\s+/g, " ")
    .replace(/ ;/g, ";")
    .trim();
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (GATED.test(pathname)) {
    const session = verifySession(request.cookies.get(SESSION_COOKIE)?.value, routeConfig().secrets.session, Date.now());
    if (!session) return NextResponse.redirect(new URL("/", request.url));
  }

  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  const csp = contentSecurityPolicy(nonce, process.env.NODE_ENV === "development");
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  // 정적 파일(빌드 산출물·이미지 최적화·public의 그림·아이콘)만 뺀다
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
