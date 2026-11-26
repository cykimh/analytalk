// 실행 환경과 비밀값. 라우트(route.ts)·페이지(viewer.ts)·proxy.ts가 같은 값을 쓴다.
// proxy.ts가 읽으므로 Anthropic SDK·DB 저장소 같은 무거운 모듈은 import하지 않는다.
import "server-only";
import { isE2E } from "@/lib/config";
import type { HandlerDeps } from "./route";

/** E2E와, 값이 없을 때의 개발 서버가 쓰는 고정 값. 프로덕션은 쓰지 않는다 */
const FIXED_SECRETS = { session: "analytalk-test-session-secret" };

/**
 * 실행 환경과 비밀값.
 * - E2E: 환경 변수와 상관없이 고정 값, Turnstile 없음, production 아님(로컬 http라 Secure 쿠키를 빼고 Turnstile도 묻지 않는다)
 * - 프로덕션: 환경 변수만 쓴다. 없는 값은 빈 문자열로 둬 핸들러가 503(또는 401)으로 닫는다
 * - 개발: 없는 세션 비밀값은 고정 값으로 채운다
 */
export function routeConfig(): Pick<HandlerDeps, "production" | "secrets"> {
  if (isE2E()) return { production: false, secrets: { ...FIXED_SECRETS } };
  const production = process.env.NODE_ENV === "production";
  const pick = (value: string | undefined, fallback: string) => value || (production ? "" : fallback);
  return {
    production,
    secrets: {
      session: pick(process.env.SESSION_SECRET, FIXED_SECRETS.session),
      turnstile: process.env.TURNSTILE_SECRET_KEY || undefined,
    },
  };
}
