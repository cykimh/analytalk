import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashCode, newInviteCode } from "./code";

// 0·O·1·I·L을 뺀 숫자 2~9와 영문 대문자 23자
const ALLOWED = /^[2-9A-HJKMNP-Z]{10}$/;

describe("newInviteCode", () => {
  it("10자이고 헷갈리는 글자(0·O·1·I·L)를 쓰지 않는다", () => {
    const codes = Array.from({ length: 500 }, () => newInviteCode());
    for (const code of codes) expect(code).toMatch(ALLOWED);
  });

  it("허용한 31자를 모두 쓴다", () => {
    const seen = new Set(Array.from({ length: 500 }, () => newInviteCode()).join(""));
    expect(seen.size).toBe(31);
  });

  it("매번 다른 코드를 만든다", () => {
    const codes = new Set(Array.from({ length: 200 }, () => newInviteCode()));
    expect(codes.size).toBe(200);
  });
});

describe("hashCode", () => {
  it("앞뒤 공백을 지우고 대문자로 바꾼 코드의 sha256 hex", () => {
    const expected = createHash("sha256").update("ABCD234567").digest("hex");
    expect(hashCode("ABCD234567")).toBe(expected);
    expect(hashCode("  abcd234567\n")).toBe(expected);
  });

  it("다른 코드는 다른 해시", () => {
    expect(hashCode("ABCD234567")).not.toBe(hashCode("ABCD234568"));
  });
});
