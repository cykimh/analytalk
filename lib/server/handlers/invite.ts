// POST /api/invite 본체와, 다른 API 맨 앞에서 부르는 requireInvite.
// 초대 코드 → Turnstile 확인 → 코드 해시 조회 → 30일 세션 쿠키. 쿠키는 서명만 믿지 않고 매번 코드 폐기 여부를 확인한다.
import "server-only";
import { z } from "zod";
import { SESSION_COOKIE, SESSION_TTL_DAYS, TURNSTILE_INVITE_ACTION } from "@/lib/config";
import { hashCode } from "@/lib/invite/code";
import { readCookie, sessionCookie, signSession, verifySession } from "@/lib/invite/session";
import { verifyTurnstile } from "@/lib/invite/turnstile";
import { fail, type HandlerDeps, type HandlerResult, readJson } from "@/lib/server/route";

const bodySchema = z.object({
  code: z.string().trim().min(1).max(64),
  turnstileToken: z.string().max(2048).optional(),
});

/** Vercel이 넣는 x-forwarded-for의 첫 번째 값. 없으면(로컬) "local" */
const clientIp = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";

export async function handleInvite(req: Request, deps: HandlerDeps): Promise<HandlerResult> {
  if (!deps.secrets.session) return fail(503, "not_ready");
  const body = bodySchema.safeParse(await readJson(req));
  if (!body.success) return fail(400, "bad_request");

  const human = await verifyTurnstile(body.data.turnstileToken ?? "", clientIp(req), TURNSTILE_INVITE_ACTION, {
    secret: deps.secrets.turnstile,
    production: deps.production,
    fetch: deps.fetch,
  });
  if (human === "not_ready") return fail(503, "not_ready");
  if (human === "fail") return fail(403, "human_check_failed");

  const invite = await deps.repo.findInvite(hashCode(body.data.code));
  if (!invite || invite.revoked) return fail(401, "invalid_code");

  const value = signSession(invite.id, deps.now() + SESSION_TTL_DAYS * 86_400_000, deps.secrets.session);
  return { status: 200, body: { ok: true }, headers: { "set-cookie": sessionCookie(value, deps.production) } };
}

/** 세션 쿠키 서명·만료와 코드 폐기 여부를 확인한다. 실패하면 { status: 401 } */
export async function requireInvite(
  req: Request,
  deps: Pick<HandlerDeps, "repo" | "secrets" | "now">,
): Promise<{ inviteId: string } | { status: 401 }> {
  const session = verifySession(readCookie(req.headers.get("cookie"), SESSION_COOKIE), deps.secrets.session, deps.now());
  if (!session) return { status: 401 };
  const invite = await deps.repo.getInvite(session.inviteId);
  if (!invite || invite.revoked) return { status: 401 };
  return { inviteId: invite.id };
}
