import { describe, expect, it } from "vitest";
import { isKakaoInApp, openExternalUrl } from "./inapp";

describe("isKakaoInApp", () => {
  it.each([
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.4.5", true],
    ["Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36 KAKAOTALK/10.4.5", true],
    ["… kakaotalk …", true],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15", false],
    ["", false],
  ])("%s → %s", (ua, expected) => {
    expect(isKakaoInApp(ua)).toBe(expected);
  });
});

describe("openExternalUrl", () => {
  it("현재 주소를 인코딩해 카카오톡 외부 열기 주소로 만든다", () => {
    expect(openExternalUrl("https://yupchang-analytalk.vercel.app/new?x=1&y=가")).toBe(
      "kakaotalk://web/openExternal?url=https%3A%2F%2Fyupchang-analytalk.vercel.app%2Fnew%3Fx%3D1%26y%3D%EA%B0%80",
    );
  });
});
