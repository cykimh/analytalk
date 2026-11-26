// GET /api/conversations/[id]/status 본체. 진행 화면이 POLL_MS마다 부른다. DB만 읽는다.
import "server-only";
import { isPaused } from "@/lib/server/repo";
import { fail, type HandlerDeps, type HandlerResult } from "@/lib/server/route";
import { NO_STORE, ownConversation } from "./conversation";
import { requireInvite } from "./invite";

/**
 * 리포트의 상태와 진행 메모(sanitizeNotes를 거친 reading_notes. 첫 메모 전에는 null).
 * paused: 지금 새 생성이 전역으로 멈춰 있다(settings.paused_until > 지금). 이 대화의 리포트 오류 코드와 상관없다.
 * true인 동안 생성·다시 쓰기는 423이다. 화면은 [다시 쓰기] 대신 "이번 달 AI 마감"을 보여 주고, 풀리면 다시 보여 준다
 */
export async function handleStatus(req: Request, deps: HandlerDeps, id: string): Promise<HandlerResult> {
  const auth = await requireInvite(req, deps);
  if (!("inviteId" in auth)) return fail(401, "unauthorized");
  const row = await ownConversation(deps.repo, id, auth.inviteId);
  if (!row) return fail(404, "not_found");
  return {
    status: 200,
    body: {
      report: { status: row.report.status, progress: row.report.progress, errorCode: row.report.errorCode },
      paused: await isPaused(deps.repo, deps.now()),
    },
    headers: NO_STORE,
  };
}
