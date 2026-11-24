// 라우트 파일과 핸들러 사이. 라우트는 respond(req, handle…)만 부르고, 핸들러는 HandlerDeps만 받아 테스트에서 바꿔 끼운다.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { getDeadline } from "@vercel/functions";
import { after } from "next/server";
import { EPISODE_DEADLINE_MS, isE2E } from "@/lib/config";
import { type AppRepo, getRepo, NotReadyError } from "./repo";

export interface HandlerDeps {
  repo: AppRepo;
  client: Anthropic | null;
  schedule: (task: () => Promise<void>) => void;
  deadlineAt: () => number;
  now: () => number;
  fetch: typeof fetch;
  secrets: { session: string; internal: string; turnstile?: string };
  production: boolean;
}

export interface HandlerResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** E2E와, 값이 없을 때의 개발 서버가 쓰는 고정 값. 프로덕션은 쓰지 않는다 */
const FIXED_SECRETS = { session: "analytalk-test-session-secret", internal: "analytalk-test-internal-secret" };

/**
 * 실행 환경과 비밀값.
 * - E2E: 환경 변수와 상관없이 고정 값, Turnstile 없음, production 아님(로컬 http라 Secure 쿠키를 빼고 Turnstile도 묻지 않는다)
 * - 프로덕션: 환경 변수만 쓴다. 없는 값은 빈 문자열로 둬 핸들러가 503(또는 401)으로 닫는다
 * - 개발: 없는 세션·내부 비밀값은 고정 값으로 채운다
 */
export function routeConfig(): Pick<HandlerDeps, "production" | "secrets"> {
  if (isE2E()) return { production: false, secrets: { ...FIXED_SECRETS } };
  const production = process.env.NODE_ENV === "production";
  const pick = (value: string | undefined, fallback: string) => value || (production ? "" : fallback);
  return {
    production,
    secrets: {
      session: pick(process.env.SESSION_SECRET, FIXED_SECRETS.session),
      internal: pick(process.env.INTERNAL_HMAC_SECRET, FIXED_SECRETS.internal),
      turnstile: process.env.TURNSTILE_SECRET_KEY || undefined,
    },
  };
}

/** 요청 하나의 deps. 편 마감은 함수 마감 30초 전과 요청 시작 + 270초 중 이른 쪽(로컬에는 함수 마감이 없다) */
export function routeDeps(start = Date.now()): HandlerDeps {
  const config = routeConfig();
  const fnDeadline = getDeadline();
  const deadline = Math.min(fnDeadline ? fnDeadline.getTime() - 30_000 : Number.POSITIVE_INFINITY, start + EPISODE_DEADLINE_MS);
  const apiKey = isE2E() ? undefined : process.env.ANTHROPIC_API_KEY;
  return {
    repo: getRepo(),
    client: apiKey ? new Anthropic({ apiKey, maxRetries: 0 }) : null,
    schedule: (task) => after(task),
    deadlineAt: () => deadline,
    now: () => Date.now(),
    fetch: (input, init) => fetch(input, init),
    ...config,
  };
}

export function toResponse({ status, body, headers }: HandlerResult): Response {
  if (status === 204 || body === undefined) return new Response(null, { status, headers });
  return Response.json(body, { status, headers });
}

/** deps를 만들어 핸들러를 부르고 결과를 Response로 바꾼다. 프로덕션에 DB 키가 없으면 503 */
export async function respond(
  req: Request,
  handler: (req: Request, deps: HandlerDeps) => Promise<HandlerResult>,
): Promise<Response> {
  let deps: HandlerDeps;
  try {
    deps = routeDeps();
  } catch (error) {
    if (error instanceof NotReadyError) return Response.json({ error: "not_ready" }, { status: 503 });
    throw error;
  }
  return toResponse(await handler(req, deps));
}
