// 모델·출력 상한·effort·입력 예산. 요청마다 env에서 읽는다(되돌리려면 env를 바꾸고 재배포).
import "server-only";
import { DEFAULT_MODEL, inputTokenBudgetFor } from "@/lib/config";

export type Effort = "low" | "medium" | "high";
/**
 * 출력 상한(생각 토큰 포함). v2.2 분량(본문 7,000자, 많아도 9,000자 + 인용 30개)은 약 1만 2천~1만 4천 토큰이라 그대로 담는다.
 * 270초 마감 안에 나올 수 있는 양(초당 약 60토큰 가정, lib/llm/prompt.ts VOLUME)이 이 상한보다 작아 마감이 먼저 온다
 */
export const DEFAULT_REPORT_MAX_TOKENS = 32_000;
export const DEFAULT_EFFORT: Effort = "medium";

export interface ModelSettings {
  model: string;
  maxTokens: number;
  effort: Effort;
  inputBudget: number;
}

const positiveInt = (v: string | undefined): number | null => {
  const n = Number(v);
  return v && Number.isInteger(n) && n > 0 ? n : null;
};

export function modelSettings(env: Record<string, string | undefined> = process.env): ModelSettings {
  const model = env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  const effort = env.ANTHROPIC_EFFORT;
  return {
    model,
    maxTokens: positiveInt(env.REPORT_MAX_TOKENS) ?? DEFAULT_REPORT_MAX_TOKENS,
    effort: effort === "low" || effort === "medium" || effort === "high" ? effort : DEFAULT_EFFORT,
    inputBudget: positiveInt(env.INPUT_TOKEN_BUDGET) ?? inputTokenBudgetFor(model),
  };
}
