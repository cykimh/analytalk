// POST /api/episodes/retry 본체: [다시 쓰기]. 브라우저가 IndexedDB에 둔 페이로드를 다시 보낸다.
// 같은 초대 코드의 대화이고, 페이로드 해시가 같아야 하고, retry_episode 판정을 통과해야 받는다:
// 정지 중이 아니고(423), 그 편을 시작할 수 있고(queued·failed·partial, 아니면 409), 그 편의 유료 실행이 MAX_EPISODE_RUNS 미만이고,
// 최근 7일 원가 + 이번 몫이 주간 상한 이하여야 한다(아니면 429 {reason: retry_limit|global_limit}). 판정과 시작은 DB에서 한 번에 한다.
import "server-only";
import { z } from "zod";
import { DEFAULT_EST_COST_USD, MAX_EPISODE_RUNS } from "@/lib/config";
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
  // 정지 중이거나 상한에 걸리면 편을 시작하지 않는다(Anthropic을 다시 부르지 않는다)
  const outcome = await deps.repo.retryEpisode({ id, n, estCost: DEFAULT_EST_COST_USD, maxRuns: MAX_EPISODE_RUNS });
  if (outcome === "paused") return fail(423, "paused");
  if (outcome === "not_startable") return fail(409, "not_startable");
  if (outcome !== "started") return { status: 429, body: { reason: outcome } };

  const job = jobDeps(deps, req.url);
  deps.schedule(() => runEpisodeJob(job, { id, n, payload: checked.payload }));
  return { status: 202, body: undefined };
}
