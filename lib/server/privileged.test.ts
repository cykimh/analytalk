import { describe, expect, it } from "vitest";
import { privilegedDb } from "./privileged";

describe("privilegedDb", () => {
  it("env를 주면 process.env 대신 그 값을 쓴다: 키가 없으면 null", () => {
    expect(privilegedDb({})).toBeNull();
    expect(privilegedDb({ NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321" })).toBeNull();
  });
  it("URL과 키가 있으면 클라이언트를 만든다", () => {
    expect(privilegedDb({ NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321", SUPABASE_SECRET_KEY: "k" })).not.toBeNull();
  });
});
