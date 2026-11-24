// POST·DELETE /api/shares 본체와 공유 화면(/s/[token])이 읽는 loadSharedView.
// 토큰은 16바이트 난수(base64url)이고 DB에는 sha256만 둔다. 원문 토큰은 URL을 만든 응답에만 한 번 나간다.
import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { StoredEpisode } from "@/lib/llm/schema";
import { resolveBaseUrl } from "@/lib/server/baseUrl";
import type { AppRepo, ConversationRow } from "@/lib/server/repo";
import { fail, type HandlerDeps, type HandlerResult, readJson } from "@/lib/server/route";
import type { ChatStats } from "@/lib/stats/compute";
import { NO_STORE, ownConversation } from "./conversation";
import { requireInvite } from "./invite";

const TOKEN_BYTES = 16;
/** 16바이트의 base64url은 22글자다 */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{22}$/;

const createSchema = z.object({
  id: z.string().min(1).max(64),
  scope: z.enum(["first", "all"]),
  hidden: z.array(z.literal([1, 2, 3, 4])).max(4),
});
const revokeSchema = z.object({ id: z.string().min(1).max(64) });

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * 공유 범위를 정한다.
 * - 아직 공유 중이 아니면 새 토큰을 만들고 `{ url }`을 돌려준다
 * - 이미 공유 중이면 토큰은 그대로 두고 범위·숨김만 바꾼다. 원문 토큰은 DB에 없어 `{ url: null }`이다(새 링크가 필요하면 폐기 후 다시 만든다)
 */
export async function handleCreateShare(req: Request, deps: HandlerDeps): Promise<HandlerResult> {
  const auth = await requireInvite(req, deps);
  if (!("inviteId" in auth)) return fail(401, "unauthorized");
  const body = createSchema.safeParse(await readJson(req));
  if (!body.success) return fail(400, "bad_request");
  const { id, scope, hidden } = body.data;

  const row = await ownConversation(deps.repo, id, auth.inviteId);
  if (!row) return fail(404, "not_found");

  const hiddenSet = [...new Set(hidden)].sort();
  if (row.shareTokenHash !== null) {
    if (!(await deps.repo.setShare(id, auth.inviteId, { tokenHash: row.shareTokenHash, scope, hidden: hiddenSet }))) {
      return fail(404, "not_found");
    }
    return { status: 200, body: { url: null }, headers: NO_STORE };
  }

  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  if (!(await deps.repo.setShare(id, auth.inviteId, { tokenHash: sha256(token), scope, hidden: hiddenSet }))) {
    return fail(404, "not_found");
  }
  return { status: 200, body: { url: `${resolveBaseUrl(req.url).baseUrl}/s/${token}` }, headers: NO_STORE };
}

/** 링크를 폐기한다(토큰 해시를 null로). 범위·숨김 설정은 남긴다 */
export async function handleRevokeShare(req: Request, deps: HandlerDeps): Promise<HandlerResult> {
  const auth = await requireInvite(req, deps);
  if (!("inviteId" in auth)) return fail(401, "unauthorized");
  const body = revokeSchema.safeParse(await readJson(req));
  if (!body.success) return fail(400, "bad_request");

  const row = await ownConversation(deps.repo, body.data.id, auth.inviteId);
  if (!row) return fail(404, "not_found");
  const share = { tokenHash: null, scope: row.shareScope ?? ("first" as const), hidden: row.shareHidden };
  if (!(await deps.repo.setShare(row.id, auth.inviteId, share))) return fail(404, "not_found");
  return { status: 204, body: undefined };
}

/** 공유 화면이 그리는 것. 표시 이름·통계·보여 줄 편의 저장된 내용뿐이다(실제 이름·transcript·anchors는 DB에 없다) */
export interface SharedView {
  concept: ConversationRow["concept"];
  displayNames: string[];
  stats: ChatStats;
  episodes: { n: number; content: StoredEpisode }[];
}

/** 범위(first면 1편만)와 숨김을 적용하고, 내용이 있는 편만 남긴다 */
export function visibleEpisodes(row: ConversationRow): SharedView["episodes"] {
  const hidden = new Set(row.shareHidden);
  const out: SharedView["episodes"] = [];
  for (const e of row.episodes) {
    if (row.shareScope === "first" && e.n !== 1) continue;
    if (hidden.has(e.n) || !e.content) continue;
    out.push({ n: e.n, content: e.content });
  }
  return out;
}

/** 토큰으로 지금 공유 중인 대화를 읽는다. 폐기·만료·삭제·모르는 토큰이면 null. 매번 저장소를 읽는다(캐시 없음) */
export async function loadSharedView(repo: AppRepo, token: string): Promise<SharedView | null> {
  if (!TOKEN_SHAPE.test(token)) return null;
  const row = await repo.getByShareHash(sha256(token));
  if (!row || row.shareScope === null) return null;
  return { concept: row.concept, displayNames: row.displayNames, stats: row.stats, episodes: visibleEpisodes(row) };
}
