// POST /api/conversations 본체: 초대 코드 → 페이로드 재검사 → 중복 → 정지 → 입력 토큰 → claim → 리포트 예약.
// 중복이거나 정지 중이면 Claude를 부르지 않는다(중복은 기존 id, 정지는 423). 리포트는 after()에서 이 함수 호출 안에서 한 번 돈다
// (v2.5: 그 안에서 호출 3~4개를 Promise로 동시에 돌린다).
import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import type { MessageCountTokensParams } from "@anthropic-ai/sdk/resources/messages";
import { DEFAULT_EST_COST_USD, PROMPT_RESERVE_TOKENS, TOKENS_PER_CHAR } from "@/lib/config";
import { classifyError } from "@/lib/llm/errors";
import { countRequest, PROMPT_VERSION } from "@/lib/llm/prompt";
import { modelSettings } from "@/lib/llm/settings";
import { type Payload, payloadTokens } from "@/lib/payload/build";
import { sha256Hex } from "@/lib/payload/hash";
import { validatePayload } from "@/lib/payload/validate";
import { limitLiftsAt, runReportJob } from "@/lib/server/jobs";
import { isPaused } from "@/lib/server/repo";
import { fail, type HandlerDeps, type HandlerResult, readJson } from "@/lib/server/route";
import { requireInvite } from "./invite";

/** countTokens 실측이 입력 예산을 이만큼까지 넘는 것은 받는다(클라이언트 글자 수 추정과의 차이) */
const BUDGET_TOLERANCE = 1.05;

/**
 * 리포트 요청의 입력 토큰. 모델이 읽는 부분만 보낸다(betas·fallbacks·max_tokens 제외).
 * v2.5: 나눠 쓰는 호출들은 데이터 블록이 같고 지시만 달라서, 지시가 가장 긴 호출(countRequest) 하나만 센다.
 * buildRequests는 GA 모양(텍스트 블록·cache_control·mid-conversation system·adaptive thinking·json_schema)만 만들어
 * 베타가 아닌 countTokens에 그대로 보낼 수 있다. 베타 타입이 더 넓어서 두 필드만 좁힌다
 */
async function countInputTokens(client: Anthropic, p: Payload): Promise<number> {
  const { model, system, messages, thinking, output_config } = countRequest(p);
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
  tone: p.tone,
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
  if (!client) return fail(503, "not_ready");

  const checked = validatePayload(await readJson(req));
  if (!checked.ok) return { status: 400, body: { error: "bad_payload", reason: checked.error } };
  const p = checked.payload;
  const payloadSha256 = await sha256Hex(JSON.stringify(p));
  const { inviteId } = auth;
  const settings = modelSettings();

  const duplicate = await deps.repo.findDuplicate({ inviteId, payloadSha256, concept: p.concept, tone: p.tone, promptVersion: PROMPT_VERSION });
  if (duplicate) return { status: 200, body: { id: duplicate } };
  // claim도 정지를 보지만(중복 다음), 그 전에 countTokens로 Anthropic을 부르지 않게 먼저 본다
  if (await isPaused(deps.repo, deps.now())) return fail(423, "paused");

  let counted: number;
  try {
    counted = await countInputTokens(client, p);
  } catch (e) {
    // 오류 종류만 남긴다(본문·문구는 남기지 않는다). 한도 오류면 생성 때와 같이 정지 시각을 걸고 423
    const kind = classifyError(e);
    console.error(`[conversations] countTokens 실패: ${kind}`);
    if (kind === "spend_limit" || kind === "credit_exhausted") {
      await deps.repo.setPaused(limitLiftsAt(kind, new Date(deps.now())));
      return fail(423, "paused");
    }
    return fail(502, "count_tokens_failed");
  }
  if (counted > settings.inputBudget * BUDGET_TOLERANCE) {
    // 클라이언트 입력 예산 단위(본문 + 통계 + 프롬프트 몫)로 돌려준다. 클라이언트는 이 값의 95%를 inputBudget으로 다시 만든다
    const estimated = payloadTokens(p, TOKENS_PER_CHAR).total + PROMPT_RESERVE_TOKENS;
    const maxTokens = Math.floor((estimated * settings.inputBudget) / counted);
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
      if (await deps.repo.startReport(id)) deps.schedule(() => runReportJob(deps, { id, payload: p }));
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
