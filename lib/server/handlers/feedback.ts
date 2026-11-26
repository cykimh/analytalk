// POST /api/feedback 본체: 리포트 문단의 [틀렸어요]. 같은 초대 코드의 대화이고, 리포트에 실제로 있는 문단이어야 남긴다.
// 남기는 것은 대화 id·문단 키·이유 코드뿐이다(문단 글은 받지 않는다).
import "server-only";
import { z } from "zod";
import { FEEDBACK_REASONS, paragraphRefs } from "@/lib/episode/feedback";
import { fail, type HandlerDeps, type HandlerResult, readJson } from "@/lib/server/route";
import { ownConversation } from "./conversation";
import { requireInvite } from "./invite";

/** 옛 탭이 보내는 편 번호(n)는 z.object가 버린다 */
const bodySchema = z.object({
  id: z.string().min(1).max(64),
  paragraphKey: z.string().min(1).max(100),
  reason: z.enum(FEEDBACK_REASONS),
});

export async function handleFeedback(req: Request, deps: HandlerDeps): Promise<HandlerResult> {
  const auth = await requireInvite(req, deps);
  if (!("inviteId" in auth)) return fail(401, "unauthorized");
  const body = bodySchema.safeParse(await readJson(req));
  if (!body.success) return fail(400, "bad_request");
  const { id, paragraphKey, reason } = body.data;

  const row = await ownConversation(deps.repo, id, auth.inviteId);
  const content = row?.report.content;
  if (!content || !paragraphRefs(content).includes(paragraphKey)) return fail(404, "not_found");

  await deps.repo.addFeedback({ id, paragraphKey, reason });
  return { status: 204, body: undefined };
}
