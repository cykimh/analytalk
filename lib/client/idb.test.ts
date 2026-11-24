import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Payload } from "@/lib/payload/build";

// idb-keyval을 메모리 Map으로 바꾼다(node에는 IndexedDB가 없다)
const store = vi.hoisted(() => new Map<string, unknown>());
vi.mock("idb-keyval", () => ({
  get: async (key: string) => store.get(key),
  set: async (key: string, value: unknown) => void store.set(key, value),
  del: async (key: string) => void store.delete(key),
  entries: async () => [...store.entries()],
}));

const { deletePayload, loadPayload, savePayload, sweepPayloads } = await import("./idb");

const payload = { v: 1, me: "멤버1", transcript: "# 2024-03-14\nm0|03-14 00:05|멤버1|안녕" } as unknown as Payload;
const HOUR = 3_600_000;

describe("idb payload", () => {
  beforeEach(() => {
    store.clear();
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 10, 24, 0, 0));
  });
  afterEach(() => vi.useRealTimers());

  it("payload:<id> 키에 저장 시각과 함께 두고 다시 읽는다", async () => {
    await savePayload("c1", payload);
    expect(store.get("payload:c1")).toEqual({ savedAt: Date.UTC(2026, 10, 24, 0, 0), payload });
    expect(await loadPayload("c1")).toEqual(payload);
  });

  it("없으면 null", async () => {
    expect(await loadPayload("none")).toBeNull();
  });

  it("24시간까지는 읽고, 넘으면 지우고 null", async () => {
    await savePayload("c1", payload);
    vi.setSystemTime(Date.UTC(2026, 10, 24, 0, 0) + 24 * HOUR);
    expect(await loadPayload("c1")).toEqual(payload);
    vi.setSystemTime(Date.UTC(2026, 10, 24, 0, 0) + 24 * HOUR + 1);
    expect(await loadPayload("c1")).toBeNull();
    expect(store.has("payload:c1")).toBe(false);
  });

  it("저장 형식이 아니면 지우고 null", async () => {
    store.set("payload:c1", { payload });
    expect(await loadPayload("c1")).toBeNull();
    expect(store.has("payload:c1")).toBe(false);
  });

  it("deletePayload는 그 키만 지운다", async () => {
    await savePayload("c1", payload);
    await savePayload("c2", payload);
    await deletePayload("c1");
    expect([...store.keys()]).toEqual(["payload:c2"]);
  });

  it("sweepPayloads는 24시간이 지났거나 형식이 다른 payload:* 만 지운다(다시 찾아오지 않은 대화의 것까지)", async () => {
    await savePayload("old", payload);
    vi.setSystemTime(Date.UTC(2026, 10, 24, 0, 0) + 12 * HOUR);
    await savePayload("fresh", payload);
    store.set("payload:broken", { payload });
    store.set("other", "그대로");
    vi.setSystemTime(Date.UTC(2026, 10, 24, 0, 0) + 24 * HOUR + 1);
    await sweepPayloads();
    expect([...store.keys()].sort()).toEqual(["other", "payload:fresh"]);
  });
});
