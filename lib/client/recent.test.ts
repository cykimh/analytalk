import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetSeries, listSeries, rememberSeries } from "./recent";

const A = "0b6c3f1e-2a4d-4c5b-9e8f-7a6b5c4d3e2f";
const B = "1b6c3f1e-2a4d-4c5b-9e8f-7a6b5c4d3e2f";
const DAY = 86_400_000;

describe("내 연재 목록 (이 브라우저의 localStorage)", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const setStorage = (descriptor: PropertyDescriptor) => Object.defineProperty(globalThis, "localStorage", { configurable: true, ...descriptor });
  let map: Map<string, string>;

  beforeEach(() => {
    map = new Map();
    setStorage({
      value: {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, String(v)),
        removeItem: (k: string) => void map.delete(k),
      },
      writable: true,
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 10, 24));
  });

  afterEach(() => {
    vi.useRealTimers();
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("만든 연재를 최근 것부터 돌려주고, 같은 id는 한 번만 둔다. 이름·대화 내용은 넣지 않는다", () => {
    rememberSeries({ id: A, concept: "couple", createdAt: Date.now() - DAY });
    rememberSeries({ id: B, concept: "group", createdAt: Date.now() });
    rememberSeries({ id: A, concept: "couple", createdAt: Date.now() - DAY });
    expect(listSeries().map((s) => s.id)).toEqual([B, A]);
    expect(JSON.parse(map.get("analytalk:recent")!)).toEqual([
      { id: B, concept: "group", createdAt: Date.now() },
      { id: A, concept: "couple", createdAt: Date.now() - DAY },
    ]);
  });

  it("30일이 지난 것(서버에서 지워짐)과 지운 대화는 빼고, 모양이 틀린 값은 무시한다", () => {
    rememberSeries({ id: A, concept: "couple", createdAt: Date.now() - 31 * DAY });
    rememberSeries({ id: B, concept: "group", createdAt: Date.now() });
    expect(listSeries().map((s) => s.id)).toEqual([B]);
    forgetSeries(B);
    expect(listSeries()).toEqual([]);
    map.set("analytalk:recent", "{not json");
    expect(listSeries()).toEqual([]);
    map.set("analytalk:recent", JSON.stringify([{ id: 1 }, { id: A, concept: "x", createdAt: 1 }]));
    expect(listSeries()).toEqual([]);
  });

  it("말투(tone)를 저장하고, tone이 없는 v1 항목은 받고, 모르는 tone은 버린다", () => {
    rememberSeries({ id: A, concept: "couple", tone: "warm", createdAt: Date.now() });
    expect(listSeries()).toEqual([{ id: A, concept: "couple", tone: "warm", createdAt: Date.now() }]);
    map.set("analytalk:recent", JSON.stringify([{ id: B, concept: "group", createdAt: Date.now() }]));
    expect(listSeries().map((s) => s.id)).toEqual([B]);
    map.set("analytalk:recent", JSON.stringify([{ id: A, concept: "group", tone: "x", createdAt: Date.now() }]));
    expect(listSeries()).toEqual([]);
  });

  it("v2.1에 더한 말투(docu·detective·record)도 저장하고 읽는다", () => {
    for (const tone of ["docu", "detective", "record"] as const) {
      rememberSeries({ id: A, concept: "group", tone, createdAt: Date.now() });
      expect(listSeries()[0]).toMatchObject({ id: A, tone });
    }
  });

  it("localStorage가 막혀도 예외 없이 빈 목록", () => {
    setStorage({
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    });
    expect(() => rememberSeries({ id: A, concept: "couple", createdAt: Date.now() })).not.toThrow();
    expect(listSeries()).toEqual([]);
    expect(() => forgetSeries(A)).not.toThrow();
  });
});
