// POST /api/episodes/retry 본체: [다시 쓰기]. 브라우저가 IndexedDB에 둔 페이로드를 다시 보낸다.
// 같은 초대 코드의 대화이고, 페이로드 해시가 같고, 그 편을 시작할 수 있어야(queued·failed·partial) 받는다.
import "server-only";
import { z } from "zod";
import { sha256Hex } from "@/lib/payload/hash";
import { validatePayload } from "@/lib/payload/validate";
import { jobDeps, runEpisodeJob } from "@/lib/server/jobs";
import { fail, type HandlerDeps, type HandlerResult, readJson } from "@/lib/server/route";
import { requireInvite } from "./invite";

const bodySchema = z.object({ id: z.string().min(1).max(64), n: z.literal([1, 2, 3, 4]), payload: z.unknown() });

export async function handleRetry(req: Request, deps: HandlerDeps): Promise<HandlerResult> {
  const auth = await requireInvite(req, deps);
  if (!("inviteId" in auth)) return fail(401, "unauthorized");
  if (!deps.client || !deps.secrets.internal) return fail(503, "not_ready");

  const body = bodySchema.safeParse(await readJson(req));
  if (!body.success) return fail(400, "bad_request");
  const checked = validatePayload(body.data.payload);
  if (!checked.ok) return { status: 400, body: { error: "bad_payload", reason: checked.error } };
  const { id, n } = body.data;
  const payloadSha256 = await sha256Hex(JSON.stringify(checked.payload));

  const row = await deps.repo.getConversation(id);
  if (!row || row.inviteId !== auth.inviteId || row.payloadSha256 !== payloadSha256) return fail(409, "payload_mismatch");
  if (!(await deps.repo.startEpisode(id, n))) return fail(409, "not_startable");

  const job = jobDeps(deps, req.url);
  deps.schedule(() => runEpisodeJob(job, { id, n, payload: checked.payload }));
  return { status: 202, body: undefined };
}
