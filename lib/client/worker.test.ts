import { describe, expect, it } from "vitest";
import { retryBuildInput } from "./worker";

describe("retryBuildInput", () => {
  it("첫 입력을 두고 inputBudget만 413 maxTokens × 0.95(내림)로 바꾼다", () => {
    const first = { messages: [], me: "P1", concept: "group" as const, kind: "group" as const, tokensPerChar: 1, inputBudget: 400_000 };
    const r = retryBuildInput(first, 100_000);
    expect(r).toEqual({ ...first, inputBudget: 95_000 });
    expect(r).not.toHaveProperty("tokenBudget");
  });
});
