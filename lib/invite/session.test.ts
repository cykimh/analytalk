import { describe, expect, it } from "vitest";
import { SESSION_COOKIE, SESSION_TTL_DAYS } from "@/lib/config";
import { readCookie, sessionCookie, signSession, verifySession } from "./session";

const SECRET = "test-session-secret-0123456789abcdef";
const ID = "0b6c3f1e-2a4d-4c5b-9e8f-7a6b5c4d3e2f";
const OTHER_ID = "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f";
const NOW = 1_800_000_000_000;
const EXP = NOW + 60_000;

describe("signSession·verifySession", () => {
  it("서명한 값은 만료 전까지 inviteId를 돌려준다", () => {
    const value = signSession(ID, EXP, SECRET);
    expect(verifySession(value, SECRET, NOW)).toEqual({ inviteId: ID });
    expect(verifySession(value, SECRET, EXP - 1)).toEqual({ inviteId: ID });
  });

  it("만료 시각이 되면 null", () => {
    const value = signSession(ID, EXP, SECRET);
    expect(verifySession(value, SECRET, EXP)).toBeNull();
    expect(verifySession(value, SECRET, EXP + 1)).toBeNull();
  });

  it("서명을 바꾸면 null", () => {
    const value = signSession(ID, EXP, SECRET);
    const flip = (s: string, i: number) => s.slice(0, i) + (s.at(i) === "A" ? "B" : "A") + s.slice(i + 1);
    expect(verifySession(flip(value, value.length - 10), SECRET, NOW)).toBeNull();
    // 마지막 글자의 하위 비트는 base64url 디코딩에서 버려진다. 글자 그대로 비교해야 잡힌다
    expect(verifySession(flip(value, value.length - 1), SECRET, NOW)).toBeNull();
  });

  it("inviteId나 만료 시각을 바꾸면 null", () => {
    const sig = signSession(ID, EXP, SECRET).split(".")[2];
    expect(verifySession(`${OTHER_ID}.${EXP}.${sig}`, SECRET, NOW)).toBeNull();
    expect(verifySession(`${ID}.${EXP + 86_400_000}.${sig}`, SECRET, NOW)).toBeNull();
  });

  it("다른 secret으로 확인하면 null", () => {
    expect(verifySession(signSession(ID, EXP, SECRET), `${SECRET}x`, NOW)).toBeNull();
  });

  it.each([undefined, "", "abc", `${ID}.${EXP}`, `${ID}.${EXP}.sig.extra`, `${ID}.soon.sig`, `.${EXP}.sig`])(
    "모양이 틀린 값 %j 는 null",
    (value) => {
      expect(verifySession(value, SECRET, NOW)).toBeNull();
    },
  );

  it("빈 secret으로는 서명하지도 확인하지도 않는다", () => {
    expect(() => signSession(ID, EXP, "")).toThrow();
    expect(verifySession(signSession(ID, EXP, SECRET), "", NOW)).toBeNull();
  });
});

describe("sessionCookie", () => {
  it("Path=/, 30일, HttpOnly, SameSite=Lax. production이면 Secure", () => {
    const secure = sessionCookie("v", true);
    expect(secure.startsWith(`${SESSION_COOKIE}=v;`)).toBe(true);
    for (const part of ["Path=/", `Max-Age=${SESSION_TTL_DAYS * 86_400}`, "HttpOnly", "SameSite=Lax"]) {
      expect(secure.split("; ")).toContain(part);
    }
    expect(secure.split("; ")).toContain("Secure");
  });

  it("production이 아니면 Secure가 없다", () => {
    const plain = sessionCookie("v", false);
    expect(plain.split("; ")).not.toContain("Secure");
    expect(plain.split("; ")).toContain("HttpOnly");
    expect(plain.split("; ")).toContain("SameSite=Lax");
  });
});

describe("readCookie", () => {
  it("Cookie 헤더에서 이름이 같은 값을 꺼낸다", () => {
    expect(readCookie(`a=1; ${SESSION_COOKIE}=x.y.z; b=2`, SESSION_COOKIE)).toBe("x.y.z");
    expect(readCookie("a=1", SESSION_COOKIE)).toBeUndefined();
    expect(readCookie(null, SESSION_COOKIE)).toBeUndefined();
  });
});
