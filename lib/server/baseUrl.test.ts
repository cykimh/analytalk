import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBaseUrl } from "./baseUrl";

afterEach(() => vi.unstubAllEnvs());

describe("resolveBaseUrl", () => {
  it("요청 URL의 origin을 쓰고, 배포 보호 우회 비밀값이 있어도 헤더를 만들지 않는다", () => {
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "bypass-1");
    expect(resolveBaseUrl("https://analytalk.example.com/api/conversations?x=1")).toEqual({ baseUrl: "https://analytalk.example.com" });
  });

  it("VERCEL_URL은 쓰지 않는다", () => {
    vi.stubEnv("VERCEL_URL", "analytalk-abc123.vercel.app");
    expect(resolveBaseUrl("https://analytalk.example.com/api/x").baseUrl).toBe("https://analytalk.example.com");
  });
});
