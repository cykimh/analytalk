import { afterEach, describe, expect, it, vi } from "vitest";
import { respond, routeConfig, toResponse } from "./route";

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

describe("toResponse·respond", () => {
  it("본문은 JSON으로, 204는 본문 없이, 헤더는 그대로", async () => {
    const json = toResponse({ status: 200, body: { ok: true }, headers: { "set-cookie": "a=1" } });
    expect(json.status).toBe(200);
    expect(json.headers.get("set-cookie")).toBe("a=1");
    expect(await json.json()).toEqual({ ok: true });
    const empty = toResponse({ status: 204, body: null });
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe("");
  });

  it("프로덕션에서 DB 키가 없으면 핸들러를 부르지 않고 503", async () => {
    vi.stubEnv("ANALYTALK_E2E", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    const handler = vi.fn();
    const res = await respond(new Request("https://analytalk.example.com/api/invite", { method: "POST" }), handler);
    expect(res.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });
});
