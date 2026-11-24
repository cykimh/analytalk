// POST /api/internal/episodes 본체. 1편 작업이 띄운 2~4편을 각자의 함수 호출에서 실행한다.
// 서명(HMAC, 60초)이 맞지 않는 요청은 외부 요청으로 보고 404로 응답한다.
import "server-only";
import { z } from "zod";
import { sha256Hex } from "@/lib/payload/hash";
import { validatePayload } from "@/lib/payload/validate";
import { INTERNAL_SIGNATURE_HEADER, jobDeps, runEpisodeJob, verifyInternal } from "@/lib/server/jobs";
import { fail, type HandlerDeps, type HandlerResult, readJson } from "@/lib/server/route";

const bodySchema = z.object({ id: z.string().min(1).max(64), n: z.literal([2, 3, 4]), payload: z.unknown() });

const notFound = fail(404, "not_found");

export async function handleInternalEpisode(req: Request, deps: HandlerDeps): Promise<HandlerResult> {
  const body = bodySchema.safeParse(await readJson(req));
  if (!body.success || body.data.payload === undefined) return notFound;
  const { id, n, payload } = body.data;
  const payloadSha256 = await sha256Hex(JSON.stringify(payload));
  const signature = req.headers.get(INTERNAL_SIGNATURE_HEADER);
  if (!verifyInternal(signature, { id, n, payloadSha256 }, deps.now(), deps.secrets.internal)) return notFound;

  const row = await deps.repo.getConversation(id);
  if (!row || row.payloadSha256 !== payloadSha256) return fail(409, "payload_mismatch");
  // 해시가 대화 행과 같으니 POST /api/conversations가 검사한 그 페이로드다. 타입을 얻으려고 한 번 더 읽는다
  const checked = validatePayload(payload);
  if (!checked.ok) return fail(409, "payload_mismatch");
  if (!(await deps.repo.startEpisode(id, n))) return fail(409, "not_startable");

  const job = jobDeps(deps, req.url);
  deps.schedule(() => runEpisodeJob(job, { id, n, payload: checked.payload }));
  return { status: 202, body: undefined };
}
