// Claude 호출 오류 분류(PRD 5장 실패 처리). 서버 전용.
// 한도·크레딧 오류는 재시도하지 않고 멈춘다(paused_until). 일시 오류만 retryable이다.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";

export type ErrorClass = "spend_limit" | "credit_exhausted" | "retryable" | "fatal";

/** API 오류 본문 `{type:"error", error:{type, message, details?:{error_code}}}` */
type ErrorBody = { error?: { type?: string; message?: string; details?: { error_code?: string } } };

const SPEND_LIMIT_MESSAGE = /\b(?:spend|spending|usage)\s+limits?\b/i;
const CREDIT_MESSAGE = /credit balance/i;

export function classifyError(e: unknown): ErrorClass {
  // APIConnectionError(타임아웃 포함)도 APIError의 하위 클래스라 먼저 본다
  if (e instanceof Anthropic.APIConnectionError) return "retryable";
  if (!(e instanceof Anthropic.APIError)) return "fatal";

  const body = (e.error ?? undefined) as ErrorBody | undefined;
  const status = e.status;
  const type = body?.error?.type ?? e.type ?? undefined;
  const code = body?.error?.details?.error_code;
  const message = body?.error?.message ?? "";

  if (status === 429 && code === "enforced_spend_limit_reached") return "spend_limit";
  if (status === 400 && type === "invalid_request_error" && SPEND_LIMIT_MESSAGE.test(message)) return "spend_limit";
  if (status === 402 && type === "billing_error") return "credit_exhausted";
  if (status === 400 && CREDIT_MESSAGE.test(message)) return "credit_exhausted";
  if (status === 429 && code === undefined) return "retryable";
  if (status !== undefined && status >= 500) return "retryable";
  // 스트림 중간 SSE 오류는 HTTP status가 없다
  if (status === undefined && (type === "overloaded_error" || type === "api_error")) return "retryable";
  return "fatal";
}
