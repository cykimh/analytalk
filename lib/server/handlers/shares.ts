// POST·DELETE /api/shares 본체와 공유 화면(/s/[token])이 읽는 loadSharedView.
// 토큰은 16바이트 난수(base64url)이고 DB에는 sha256만 둔다. 원문 토큰은 URL을 만든 응답에만 한 번 나간다.
import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Tone } from "@/lib/llm/concepts";
import type { StoredReport } from "@/lib/llm/schema";
import { resolveBaseUrl } from "@/lib/server/baseUrl";
import type { AppRepo, ConversationRow } from "@/lib/server/repo";
import { fail, type HandlerDeps, type HandlerResult, readJson } from "@/lib/server/route";
import type { ChatStats } from "@/lib/stats/compute";
import { NO_STORE, ownConversation } from "./conversation";
import { requireInvite } from "./invite";

const TOKEN_BYTES = 16;
/** 16바이트의 base64url은 22글자다 */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{22}$/;

/** 옛 탭이 보내는 scope·hidden은 z.object가 버린다(한 편이라 범위·숨김이 없다) */
const bodySchema = z.object({ id: z.string().min(1).max(64) });

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * 공유 링크를 만든다.
 * - 아직 공유 중이 아니면 새 토큰을 만들고 `{ url, shared: true }`를 돌려준다
 * - 이미 공유 중이면 쓰지 않는다. 원문 토큰은 DB에 없어 `{ url: null, shared: true }`이다(발급한 URL은 클라이언트가 보관한다. 새 링크가 필요하면 폐기 후 다시 만든다)
 * - 읽은 뒤 다른 요청이 먼저 발급했으면 쓰지 않고 409다
 */
export async function handleCreateShare(req: Request, deps: HandlerDeps): Promise<HandlerResult> {
  const auth = await requireInvite(req, deps);
  if (!("inviteId" in auth)) return fail(401, "unauthorized");
  const body = bodySchema.safeParse(await readJson(req));
  if (!body.success) return fail(400, "bad_request");
  const { id } = body.data;

  const row = await ownConversation(deps.repo, id, auth.inviteId);
  if (!row) return fail(404, "not_found");
  if (row.shareTokenHash !== null) return { status: 200, body: { url: null, shared: true }, headers: NO_STORE };

  const issued = randomBytes(TOKEN_BYTES).toString("base64url");
  // 읽은 뒤 다른 요청이 먼저 발급했으면 쓰지 않는다
  if (!(await deps.repo.setShare(id, auth.inviteId, { tokenHash: sha256(issued), expectHash: null }))) {
    // 조건이 안 맞았다: 대화가 사라졌으면 404, 아니면 동시에 바뀐 것이라 409
    return (await deps.repo.getConversation(id)) ? fail(409, "conflict") : fail(404, "not_found");
  }
  return { status: 200, body: { url: `${resolveBaseUrl(req.url).baseUrl}/s/${issued}`, shared: true }, headers: NO_STORE };
}

/** 링크를 폐기한다(토큰 해시를 null로) */
export async function handleRevokeShare(req: Request, deps: HandlerDeps): Promise<HandlerResult> {
  const auth = await requireInvite(req, deps);
  if (!("inviteId" in auth)) return fail(401, "unauthorized");
  const body = bodySchema.safeParse(await readJson(req));
  if (!body.success) return fail(400, "bad_request");

  const row = await ownConversation(deps.repo, body.data.id, auth.inviteId);
  if (!row) return fail(404, "not_found");
  if (!(await deps.repo.setShare(row.id, auth.inviteId, { tokenHash: null }))) return fail(404, "not_found");
  return { status: 204, body: undefined };
}

/**
 * 공유 화면이 그리는 것. 컨셉·말투·표시 이름(업로더가 정한 이름)·통계·리포트 내용뿐이다(transcript·anchors는 DB에 없다).
 * report는 저장된 내용이 없으면(쓰는 중·실패) null
 */
export interface SharedView {
  concept: ConversationRow["concept"];
  tone: Tone;
  displayNames: string[];
  stats: ChatStats;
  report: StoredReport | null;
}

/** 토큰으로 지금 공유 중인 대화를 읽는다. 폐기·만료·삭제·모르는 토큰이면 null. 매번 저장소를 읽는다(캐시 없음) */
export async function loadSharedView(repo: AppRepo, token: string): Promise<SharedView | null> {
  if (!TOKEN_SHAPE.test(token)) return null;
  const row = await repo.getByShareHash(sha256(token));
  if (!row) return null;
  return { concept: row.concept, tone: row.tone, displayNames: row.displayNames, stats: row.stats, report: row.report.content };
}
