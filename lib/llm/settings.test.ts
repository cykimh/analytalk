import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, inputTokenBudgetFor } from "@/lib/config";
import { DEFAULT_EFFORT, DEFAULT_REPORT_MAX_TOKENS, modelSettings } from "./settings";

describe("modelSettings", () => {
  it("env가 비면 기본값", () => {
    expect(modelSettings({})).toEqual({
      model: DEFAULT_MODEL,
      maxTokens: 32_000,
      effort: "medium",
      inputBudget: inputTokenBudgetFor(DEFAULT_MODEL),
    });
    expect(DEFAULT_REPORT_MAX_TOKENS).toBe(32_000);
    expect(DEFAULT_EFFORT).toBe("medium");
  });

  it.each([
    ["claude-sonnet-5-5", 400_000],
    ["claude-opus-5-5-20261101", 128_000],
    ["claude-sonnet-5", 128_000],
  ])("ANTHROPIC_MODEL %s → 입력 예산 %i", (model, budget) => {
    expect(modelSettings({ ANTHROPIC_MODEL: model })).toMatchObject({ model, inputBudget: budget });
  });

  it("INPUT_TOKEN_BUDGET이 모델 기본보다 앞선다", () => {
    expect(modelSettings({ ANTHROPIC_MODEL: "claude-sonnet-5-5", INPUT_TOKEN_BUDGET: "200000" }).inputBudget).toBe(200_000);
  });

  it.each(["0", "-1", "abc", "12.5"])("잘못된 INPUT_TOKEN_BUDGET %s는 기본값", (v) => {
    expect(modelSettings({ INPUT_TOKEN_BUDGET: v }).inputBudget).toBe(inputTokenBudgetFor(DEFAULT_MODEL));
  });

  it("REPORT_MAX_TOKENS는 양의 정수만", () => {
    expect(modelSettings({ REPORT_MAX_TOKENS: "9000" }).maxTokens).toBe(9000);
    for (const v of ["0", "-1", "abc", "1.5"]) expect(modelSettings({ REPORT_MAX_TOKENS: v }).maxTokens).toBe(32_000);
  });

  it.each(["xhigh", "max", ""])("ANTHROPIC_EFFORT %j는 medium", (v) => {
    expect(modelSettings({ ANTHROPIC_EFFORT: v }).effort).toBe("medium");
  });

  it("ANTHROPIC_EFFORT low", () => {
    expect(modelSettings({ ANTHROPIC_EFFORT: "low" }).effort).toBe("low");
  });
});
