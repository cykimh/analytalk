import { describe, expect, it } from "vitest";
import { INPUT_TOKEN_BUDGET } from "@/lib/config";
import { retryBuildInput } from "./worker";

describe("retryBuildInput", () => {
  it("첫 요청의 inputBudget을 빼고 413의 maxTokens × 0.95(내림)를 tokenBudget으로 쓴다", () => {
    const first = { messages: [], me: "P1", concept: "group" as const, kind: "group" as const, tokensPerChar: 1, inputBudget: INPUT_TOKEN_BUDGET };
    expect(retryBuildInput(first, 100_001)).toEqual({
      messages: [],
      me: "P1",
      concept: "group",
      kind: "group",
      tokensPerChar: 1,
      tokenBudget: 95_000,
    });
  });
});
