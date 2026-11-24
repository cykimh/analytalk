// POST /api/conversations 본체: 초대 코드 → 페이로드 재검사 → 중복 → 입력 토큰 → claim → 1편 예약.
// 중복이면 Claude를 부르지 않고 기존 id를 돌려준다. 1편은 after()에서 돌고, 응답이 시작되면 2~4편을 띄운다.
import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import type { MessageCountTokensParams } from "@anthropic-ai/sdk/resources/messages";
import { DEFAULT_EST_COST_USD, INPUT_TOKEN_BUDGET, TOKENS_PER_CHAR } from "@/lib/config";
import { buildRequest, PROMPT_VERSION } from "@/lib/llm/prompt";
import { type Payload, payloadTokens } from "@/lib/payload/build";
import { sha256Hex } from "@/lib/payload/hash";
import { validatePayload } from "@/lib/payload/validate";
import { jobDeps, runEpisodeJob } from "@/lib/server/jobs";
import { fail, type HandlerDeps, type HandlerResult, readJson } from "@/lib/server/route";
import { requireInvite } from "./invite";

/** countTokens 실측이 입력 예산을 이만큼까지 넘는 것은 받는다(클라이언트 글자 수 추정과의 차이) */
const BUDGET_TOLERANCE = 1.05;

/**
 * 1편 요청의 입력 토큰. 모델이 읽는 부분만 보낸다(betas·fallbacks·max_tokens 제외).
 * buildRequest는 GA 모양(텍스트 블록·mid-conversation system·adaptive thinking·json_schema)만 만들어
 * 베타가 아닌 countTokens에 그대로 보낼 수 있다. 베타 타입이 더 넓어서 두 필드만 좁힌다
 */
async function countInputTokens(client: Anthropic, p: Payload): Promise<number> {
  const { model, system, messages, thinking, output_config } = buildRequest(p, 1, []);
  const counted = await client.messages.countTokens({
    model,
    system,
    messages: messages as MessageCountTokensParams["messages"],
    thinking: thinking as MessageCountTokensParams["thinking"],
    output_config,
  });
  return counted.input_tokens;
}

/** conversations 열 이름을 키로 한 저장 값. 페이로드 중 transcript·anchors·me·maskCounts는 넣지 않는다 */
const conversationMeta = (p: Payload) => ({
  prompt_version: PROMPT_VERSION,
  kind: p.kind,
  period_start: p.period.start,
  period_end: p.period.end,
  cutoff_at: p.cutoffAt,
  msg_total: p.msgTotal,
  msg_sent: p.msgSent,
  display_names: p.members,
  stats: p.stats,
});

export async function handleCreateConversation(req: Request, deps: HandlerDeps): Promise<HandlerResult> {
  const auth = await requireInvite(req, deps);
  if (!("inviteId" in auth)) return fail(401, "unauthorized");
  const { client } = deps;
  // 키가 없으면 개발에서도 가짜 클라이언트 없이 503이다
  if (!client || !deps.secrets.internal) return fail(503, "not_ready");

  const checked = validatePayload(await readJson(req));
  if (!checked.ok) return { status: 400, body: { error: "bad_payload", reason: checked.error } };
  const p = checked.payload;
  const payloadSha256 = await sha256Hex(JSON.stringify(p));
  const { inviteId } = auth;

  const duplicate = await deps.repo.findDuplicate({ inviteId, payloadSha256, concept: p.concept, promptVersion: PROMPT_VERSION });
  if (duplicate) return { status: 200, body: { id: duplicate } };

  let counted: number;
  try {
    counted = await countInputTokens(client, p);
  } catch {
    return fail(502, "count_tokens_failed");
  }
  if (counted > INPUT_TOKEN_BUDGET * BUDGET_TOLERANCE) {
    // 클라이언트 추정 단위(anchors + transcript)로 돌려준다. 클라이언트는 이 값의 95%로 다시 만든다(R7)
    const maxTokens = Math.floor((payloadTokens(p, TOKENS_PER_CHAR).text * INPUT_TOKEN_BUDGET) / counted);
    return { status: 413, body: { maxTokens } };
  }

  const claim = await deps.repo.claim({
    inviteId,
    concept: p.concept,
    payloadSha256,
    meta: conversationMeta(p),
    estCost: DEFAULT_EST_COST_USD,
  });
  switch (claim.outcome) {
    case "created": {
      const { id } = claim;
      if (await deps.repo.startEpisode(id, 1)) {
        const job = jobDeps(deps, req.url);
        deps.schedule(() => runEpisodeJob(job, { id, n: 1, payload: p }));
      }
      return { status: 202, body: { id } };
    }
    case "duplicate":
      return { status: 200, body: { id: claim.id } };
    case "paused":
      return fail(423, "paused");
    case "revoked":
      return fail(401, "unauthorized");
    default:
      return { status: 429, body: { reason: claim.outcome } };
  }
}
