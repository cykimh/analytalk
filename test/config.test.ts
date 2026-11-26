import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MODEL,
  INPUT_TOKEN_BUDGET_BY_MODEL,
  EPISODE_DEADLINE_MS,
  MAX_PAYLOAD_BYTES,
  WEEKLY_CAP_USD,
  isE2E,
} from "@/lib/config";

afterEach(() => vi.unstubAllEnvs());

describe("config", () => {
  it("PRD 수치를 그대로 쓴다", () => {
    expect(EPISODE_DEADLINE_MS).toBe(270_000);
    expect(MAX_PAYLOAD_BYTES).toBe(4_000_000);
    expect(WEEKLY_CAP_USD).toBe(22.5);
    expect(DEFAULT_MODEL).toBe("claude-opus-5-5");
  });

  it("모델별 입력 예산 표에서 뒤 id가 앞 id의 접두가 아니다(먼저 맞는 행이 이긴다)", () => {
    INPUT_TOKEN_BUDGET_BY_MODEL.forEach(([id], i) => {
      for (const [prev] of INPUT_TOKEN_BUDGET_BY_MODEL.slice(0, i)) expect(id === prev || id.startsWith(`${prev}-`)).toBe(false);
    });
  });

  it("Vercel에서는 E2E 모드가 꺼진다", () => {
    vi.stubEnv("ANALYTALK_E2E", "1");
    vi.stubEnv("VERCEL", "1");
    expect(isE2E()).toBe(false);
  });

  it("Vercel이 아니고 ANALYTALK_E2E=1이면 E2E 모드가 켜진다", () => {
    vi.stubEnv("ANALYTALK_E2E", "1");
    vi.stubEnv("VERCEL", "");
    expect(isE2E()).toBe(true);
  });

  it("ANALYTALK_E2E가 1이 아니면 꺼진다", () => {
    vi.stubEnv("ANALYTALK_E2E", "");
    expect(isE2E()).toBe(false);
  });
});
