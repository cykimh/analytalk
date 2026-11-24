// GET·DELETE /api/conversations/[id] 본체. 같은 초대 코드로 만든 대화만 읽고 지운다(다르면 404).
import "server-only";
import type { AppRepo, ConversationRow } from "@/lib/server/repo";
import { fail, type HandlerDeps, type HandlerResult } from "@/lib/server/route";
import { requireInvite } from "./invite";

/** 대화 내용이 든 응답은 캐시에 남기지 않는다 */
export const NO_STORE = { "cache-control": "no-store" };

/** 이 초대 코드의 대화. 없거나 만료됐거나 다른 코드의 대화면 null */
export async function ownConversation(repo: AppRepo, id: string, inviteId: string): Promise<ConversationRow | null> {
  const row = await repo.getConversation(id);
  return row && row.inviteId === inviteId ? row : null;
}

export async function handleGetConversation(req: Request, deps: HandlerDeps, id: string): Promise<HandlerResult> {
  const auth = await requireInvite(req, deps);
  if (!("inviteId" in auth)) return fail(401, "unauthorized");
  const row = await ownConversation(deps.repo, id, auth.inviteId);
  if (!row) return fail(404, "not_found");
  return {
    status: 200,
    body: {
      concept: row.concept,
      kind: row.kind,
      displayNames: row.displayNames,
      stats: row.stats,
      cutoffAt: row.cutoffAt,
      msgSent: row.msgSent,
      expiresAt: row.expiresAt,
      // 링크가 살아 있는지만 알린다. 토큰 해시는 내보내지 않는다
      shared: row.shareTokenHash !== null,
      shareScope: row.shareScope,
      shareHidden: row.shareHidden,
      episodes: row.episodes.map(({ n, status, content, errorCode }) => ({ n, status, content, errorCode })),
    },
    headers: NO_STORE,
  };
}

/** 대화·편·피드백을 지운다. claim 원장은 남아 이번 주기 한도와 오늘 건수가 되돌아가지 않는다 */
export async function handleDeleteConversation(req: Request, deps: HandlerDeps, id: string): Promise<HandlerResult> {
  const auth = await requireInvite(req, deps);
  if (!("inviteId" in auth)) return fail(401, "unauthorized");
  if (!(await deps.repo.deleteConversation(id, auth.inviteId))) return fail(404, "not_found");
  return { status: 204, body: undefined };
}
