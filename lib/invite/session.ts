// 초대 코드로 들어온 뒤의 세션 쿠키. 값은 "<inviteId>.<만료 ms>.<HMAC>"이고 SESSION_SECRET으로 서명한다.
// 서명만으로 통과시키지 않는다: API는 requireInvite로 코드 폐기 여부를 매번 확인한다.
// proxy.ts(Node 런타임)도 서명 확인에 쓸 수 있게 server-only를 붙이지 않는다.
import { createHmac, timingSafeEqual } from "node:crypto";
import { SESSION_COOKIE, SESSION_TTL_DAYS } from "@/lib/config";

const sign = (payload: string, secret: string) =>
  createHmac("sha256", secret).update(`analytalk-session:v1:${payload}`).digest("base64url");

export function signSession(inviteId: string, expMs: number, secret: string): string {
  if (!secret) throw new Error("세션 secret이 없다");
  const payload = `${inviteId}.${expMs}`;
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySession(cookie: string | undefined, secret: string, nowMs: number): { inviteId: string } | null {
  if (!cookie || !secret) return null;
  const parts = cookie.split(".");
  if (parts.length !== 3) return null;
  const [inviteId, expText, sig] = parts;
  const exp = Number(expText);
  if (!inviteId || !/^\d+$/.test(expText) || !Number.isSafeInteger(exp) || exp <= nowMs) return null;
  // base64url 디코딩은 마지막 글자의 남는 비트를 버리므로 글자 그대로 비교한다
  const expected = Buffer.from(sign(`${inviteId}.${expText}`, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { inviteId };
}

/** Set-Cookie 값. Secure는 production에서만 붙인다(로컬 http 개발·E2E) */
export function sessionCookie(value: string, production: boolean): string {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${SESSION_TTL_DAYS * 86_400}; HttpOnly; SameSite=Lax${production ? "; Secure" : ""}`;
}

export function readCookie(header: string | null, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}
