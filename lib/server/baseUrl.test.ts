import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBaseUrl } from "./baseUrl";

afterEach(() => vi.unstubAllEnvs());

describe("resolveBaseUrl", () => {
  it("요청 URL의 origin을 쓰고, 우회 비밀값이 없으면 헤더가 없다", () => {
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "");
    expect(resolveBaseUrl("https://analytalk.example.com/api/conversations?x=1")).toEqual({
      baseUrl: "https://analytalk.example.com",
      headers: {},
    });
  });

  it("VERCEL_AUTOMATION_BYPASS_SECRET이 있으면 x-vercel-protection-bypass 헤더를 붙인다", () => {
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "bypass-1");
    expect(resolveBaseUrl("http://localhost:3100/api/conversations").headers).toEqual({
      "x-vercel-protection-bypass": "bypass-1",
    });
  });

  it("VERCEL_URL은 쓰지 않는다", () => {
    vi.stubEnv("VERCEL_URL", "analytalk-abc123.vercel.app");
    expect(resolveBaseUrl("https://analytalk.example.com/api/x").baseUrl).toBe("https://analytalk.example.com");
  });
});
