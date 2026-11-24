// Cloudflare Turnstile 서버 확인. secret이 없으면 개발·E2E는 확인 없이 통과하고, 프로덕션은 not_ready(→ 503)로 닫는다.
import "server-only";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** Turnstile 토큰은 최대 2048자 */
const MAX_TOKEN = 2048;

export async function verifyTurnstile(
  token: string,
  ip: string,
  action: string,
  deps: { secret?: string; production: boolean; fetch: typeof fetch },
): Promise<"ok" | "fail" | "not_ready"> {
  if (!deps.secret) return deps.production ? "not_ready" : "ok";
  if (!token || token.length > MAX_TOKEN) return "fail";
  const form = new URLSearchParams({ secret: deps.secret, response: token });
  if (ip && ip !== "local") form.set("remoteip", ip);
  try {
    const res = await deps.fetch(SITEVERIFY_URL, { method: "POST", body: form, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return "fail";
    const data = (await res.json()) as { success?: boolean; action?: string; "error-codes"?: string[] };
    if (data.success !== true) {
      console.warn("[turnstile] siteverify 거절", data["error-codes"]);
      return "fail";
    }
    return data.action === action ? "ok" : "fail";
  } catch {
    console.warn("[turnstile] siteverify 호출 실패");
    return "fail";
  }
}
