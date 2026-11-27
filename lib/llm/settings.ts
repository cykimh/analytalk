// 모델·출력 상한·effort·입력 예산. 요청마다 env에서 읽는다(되돌리려면 env를 바꾸고 재배포).
import "server-only";
import { DEFAULT_MODEL, inputTokenBudgetFor } from "@/lib/config";

export type Effort = "low" | "medium" | "high";
/**
 * 출력 상한(생각 토큰 포함). v2.2 full 분량(본문 6,000자 안팎. 지시가 시키는 문단 상한 40개 × 190자여도 7,600자로 8,000자 안,
 * + 인용 30개 + 생각 약 2,000토큰 가정)은 약 1만 1천~1만 2천 토큰이라 그대로 담는다. 270초 마감 안에 나올 수 있는 출력은 약 13,500토큰(초당 약 60토큰 × 225초 가정,
 * lib/llm/prompt.ts VOLUMES)으로 이 상한보다 작아서 실제 한계는 마감이다. 속도·생각 토큰·첫 토큰 시간은 pnpm measure로 실측해야 한다
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
