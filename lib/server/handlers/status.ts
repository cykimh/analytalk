// GET /api/conversations/[id]/status 본체. 진행 화면이 POLL_MS마다 부른다. DB만 읽는다.
import "server-only";
import { fail, type HandlerDeps, type HandlerResult } from "@/lib/server/route";
import { NO_STORE, ownConversation } from "./conversation";
import { requireInvite } from "./invite";

/**
 * 편마다 상태와 진행 메모(sanitizeNotes를 거친 reading_notes).
 * paused: 이 대화의 편이 한도 오류(error_code limit)로 멈췄다. 화면은 [다시 쓰기] 대신 "이번 달 AI 마감"을 보여 준다
 */
export async function handleStatus(req: Request, deps: HandlerDeps, id: string): Promise<HandlerResult> {
  const auth = await requireInvite(req, deps);
  if (!("inviteId" in auth)) return fail(401, "unauthorized");
  const row = await ownConversation(deps.repo, id, auth.inviteId);
  if (!row) return fail(404, "not_found");
  return {
    status: 200,
    body: {
      episodes: row.episodes.map(({ n, status, progress, errorCode }) => ({ n, status, progress, errorCode })),
      paused: row.episodes.some((e) => e.errorCode === "limit"),
    },
    headers: NO_STORE,
  };
}
