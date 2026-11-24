import { afterEach, describe, expect, it, vi } from "vitest";
import { routeConfig } from "./env";

afterEach(() => vi.unstubAllEnvs());

function stubSecrets(values: { session?: string; internal?: string; turnstile?: string }) {
  vi.stubEnv("SESSION_SECRET", values.session ?? "");
  vi.stubEnv("INTERNAL_HMAC_SECRET", values.internal ?? "");
  vi.stubEnv("TURNSTILE_SECRET_KEY", values.turnstile ?? "");
}

describe("routeConfig", () => {
  it("E2E 모드는 환경 변수와 상관없이 고정 테스트 비밀값을 쓰고 production이 아니다", () => {
    vi.stubEnv("ANALYTALK_E2E", "1");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("NODE_ENV", "production");
    stubSecrets({ session: "real-session", internal: "real-internal", turnstile: "real-turnstile" });
    const config = routeConfig();
    expect(config.production).toBe(false);
    expect(config.secrets.session).not.toBe("real-session");
    expect(config.secrets.session.length).toBeGreaterThan(0);
    expect(config.secrets.internal).not.toBe("real-internal");
    expect(config.secrets.turnstile).toBeUndefined();
  });

  it("프로덕션은 환경 변수 값을 쓰고, 없는 값은 비워 둔다(핸들러가 503)", () => {
    vi.stubEnv("ANALYTALK_E2E", "");
    vi.stubEnv("NODE_ENV", "production");
    stubSecrets({ session: "real-session", turnstile: "real-turnstile" });
    expect(routeConfig()).toEqual({
      production: true,
      secrets: { session: "real-session", internal: "", turnstile: "real-turnstile" },
    });
    stubSecrets({});
    expect(routeConfig().secrets).toEqual({ session: "", internal: "", turnstile: undefined });
  });

  it("Vercel에서는 ANALYTALK_E2E=1이어도 E2E가 아니다", () => {
    vi.stubEnv("ANALYTALK_E2E", "1");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("NODE_ENV", "production");
    stubSecrets({});
    expect(routeConfig()).toEqual({ production: true, secrets: { session: "", internal: "", turnstile: undefined } });
  });

  it("개발에서 없는 세션·내부 비밀값은 고정 개발 값으로 채운다", () => {
    vi.stubEnv("ANALYTALK_E2E", "");
    vi.stubEnv("NODE_ENV", "development");
    stubSecrets({});
    const config = routeConfig();
    expect(config.production).toBe(false);
    expect(config.secrets.session.length).toBeGreaterThan(0);
    expect(config.secrets.internal.length).toBeGreaterThan(0);
    expect(config.secrets.turnstile).toBeUndefined();
  });
});
