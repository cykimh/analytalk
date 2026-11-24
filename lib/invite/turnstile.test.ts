import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyTurnstile } from "./turnstile";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

function fakeFetch(body: unknown, status = 200) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
}

const deps = (fetch: typeof globalThis.fetch, o: { secret?: string; production?: boolean } = {}) => ({
  secret: "secret" in o ? o.secret : "ts-secret",
  production: o.production ?? true,
  fetch,
});

afterEach(() => vi.restoreAllMocks());

describe("verifyTurnstile", () => {
  it("secret이 없으면 개발은 ok, 프로덕션은 not_ready. siteverify를 부르지 않는다", async () => {
    const fetch = fakeFetch({ success: true, action: "invite" });
    expect(await verifyTurnstile("tok", "1.2.3.4", "invite", deps(fetch, { secret: undefined, production: false }))).toBe("ok");
    expect(await verifyTurnstile("tok", "1.2.3.4", "invite", deps(fetch, { secret: undefined, production: true }))).toBe("not_ready");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("성공이고 action이 같으면 ok. secret·토큰·IP를 form으로 보낸다", async () => {
    const fetch = fakeFetch({ success: true, action: "invite" });
    expect(await verifyTurnstile("tok", "1.2.3.4", "invite", deps(fetch))).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(SITEVERIFY);
    expect(init?.method).toBe("POST");
    const form = new URLSearchParams(init?.body as URLSearchParams);
    expect(Object.fromEntries(form)).toEqual({ secret: "ts-secret", response: "tok", remoteip: "1.2.3.4" });
  });

  it("IP를 모르면(local) remoteip를 빼고 보낸다", async () => {
    const fetch = fakeFetch({ success: true, action: "invite" });
    await verifyTurnstile("tok", "local", "invite", deps(fetch));
    const form = new URLSearchParams(fetch.mock.calls[0][1]?.body as URLSearchParams);
    expect(form.has("remoteip")).toBe(false);
  });

  it("성공이어도 action이 다르면 fail", async () => {
    expect(await verifyTurnstile("tok", "1.2.3.4", "invite", deps(fakeFetch({ success: true, action: "other" })))).toBe("fail");
  });

  it("success가 false면 fail", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = fakeFetch({ success: false, "error-codes": ["invalid-input-response"] });
    expect(await verifyTurnstile("tok", "1.2.3.4", "invite", deps(fetch))).toBe("fail");
  });

  it("HTTP 오류나 네트워크 오류면 fail", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await verifyTurnstile("tok", "1.2.3.4", "invite", deps(fakeFetch({}, 500)))).toBe("fail");
    const broken = vi.fn<typeof fetch>(async () => {
      throw new TypeError("network");
    });
    expect(await verifyTurnstile("tok", "1.2.3.4", "invite", deps(broken))).toBe("fail");
  });

  it("토큰이 비었거나 2048자를 넘으면 부르지 않고 fail", async () => {
    const fetch = fakeFetch({ success: true, action: "invite" });
    expect(await verifyTurnstile("", "1.2.3.4", "invite", deps(fetch))).toBe("fail");
    expect(await verifyTurnstile("x".repeat(2049), "1.2.3.4", "invite", deps(fetch))).toBe("fail");
    expect(fetch).not.toHaveBeenCalled();
  });
});
