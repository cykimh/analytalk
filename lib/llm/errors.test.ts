import Anthropic from "@anthropic-ai/sdk";
import type { ErrorType } from "@anthropic-ai/sdk/resources/shared";
import { describe, expect, it } from "vitest";
import { classifyError, type ErrorClass } from "./errors";

const apiError = (status: number, error?: { type: string; message?: string; details?: { error_code: string } }) =>
  Anthropic.APIError.generate(status, error ? { type: "error", error } : undefined, undefined, new Headers());

/** SDK가 스트림 중간 `event: error`에서 만드는 것과 같은 오류(status 없음) */
const sseError = (type: ErrorType) =>
  new Anthropic.APIError(undefined, { type: "error", error: { type, message: type } }, undefined, new Headers(), type);

const cases: [string, ErrorClass, unknown][] = [
  [
    "429 + details.error_code enforced_spend_limit_reached",
    "spend_limit",
    apiError(429, {
      type: "rate_limit_error",
      message: "monthly spend limit reached",
      details: { error_code: "enforced_spend_limit_reached" },
    }),
  ],
  [
    "400 invalid_request_error 사용 한도 메시지",
    "spend_limit",
    apiError(400, {
      type: "invalid_request_error",
      message: "You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.",
    }),
  ],
  [
    "details 없는 429",
    "retryable",
    apiError(429, { type: "rate_limit_error", message: "Number of request tokens has exceeded your rate limit" }),
  ],
  ["402 billing_error", "credit_exhausted", apiError(402, { type: "billing_error", message: "payment required" })],
  [
    "400 credit balance 메시지",
    "credit_exhausted",
    apiError(400, { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." }),
  ],
  ["529", "retryable", apiError(529, { type: "overloaded_error", message: "Overloaded" })],
  ["500 본문 없음", "retryable", apiError(500)],
  ["401", "fatal", apiError(401, { type: "authentication_error", message: "invalid x-api-key" })],
  ["403", "fatal", apiError(403, { type: "permission_error", message: "forbidden" })],
  ["404", "fatal", apiError(404, { type: "not_found_error", message: "model: claude-x" })],
  ["다른 400", "fatal", apiError(400, { type: "invalid_request_error", message: "max_tokens: too large" })],
  [
    "다른 error_code가 붙은 429",
    "fatal",
    apiError(429, { type: "rate_limit_error", message: "x", details: { error_code: "something_else" } }),
  ],
  ["스트림 중간 SSE overloaded_error", "retryable", sseError("overloaded_error")],
  ["스트림 중간 SSE api_error", "retryable", sseError("api_error")],
  ["스트림 중간 SSE invalid_request_error", "fatal", sseError("invalid_request_error")],
  ["APIConnectionError", "retryable", new Anthropic.APIConnectionError({ message: "fetch failed" })],
  ["APIConnectionTimeoutError", "retryable", new Anthropic.APIConnectionTimeoutError()],
  ["사용자 abort", "fatal", new Anthropic.APIUserAbortError()],
  ["SDK 밖의 오류", "fatal", new Error("boom")],
  ["오류가 아닌 값", "fatal", "boom"],
];

describe("classifyError", () => {
  it.each(cases)("%s → %s", (_, expected, error) => {
    expect(classifyError(error)).toBe(expected);
  });
});
