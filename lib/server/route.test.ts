import { afterEach, describe, expect, it, vi } from "vitest";
import { respond, toResponse } from "./route";

afterEach(() => vi.unstubAllEnvs());

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
