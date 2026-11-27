// 모델·출력 상한·effort·입력 예산. 요청마다 env에서 읽는다(되돌리려면 env를 바꾸고 재배포).
import "server-only";
import { DEFAULT_MODEL, inputTokenBudgetFor } from "@/lib/config";

export type Effort = "low" | "medium" | "high";
/**
 * 출력 상한(생각 토큰 포함). v2.3 full 분량의 위쪽 끝(40문단 × 400자 = 16,000자 + JSON·인용 30개 약 2,800토큰 + 생각 약 2,000토큰)은
 * 약 20,800토큰이라 그대로 담는다. 270초 마감 안에 나올 수 있는 출력은 보수적으로 약 21,150토큰
 * (초당 90토큰 × 235초, lib/llm/prompt.ts DEADLINE_ESTIMATE. 2026-11-27 운영 실측은 110~150 tok/s)이고 실측 속도로는 3만 토큰 안팎이라
 * 32,000은 리포트를 먼저 자르지 않는 값이다. 실제 한계는 마감이다(prompt.test가 맞춰 본다). 빠듯하면 DEFAULT_EFFORT를 low로
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
