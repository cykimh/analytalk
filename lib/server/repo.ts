// 앱 저장소. Supabase(analytalk 스키마, secret 키)가 기본이고, E2E·키 없는 개발·테스트는 memoryRepo를 쓴다.
// memoryRepo는 sideinfra/supabase/migrations/20261123063000_analytalk_core.sql + 20261126090000_analytalk_v2.sql의 함수 규칙을 그대로 재현한다.
// 규칙을 바꾸면 SQL·pgTAP과 이 파일·repo.test.ts를 함께 고친다.
// v2: 대화당 리포트 한 편. DB는 episodes 표의 n = 1 한 행에 두고(SQL 함수의 p_n은 늘 REPORT_N), 남은 v1 대화의 2~4편 행은 읽지 않는다.
import "server-only";
import { randomUUID } from "node:crypto";
import { CYCLE_ANCHOR_DAY, E2E_INVITE_CODE, isE2E, MONTHLY_BUDGET_USD, RETENTION_DAYS, WEEKLY_CAP_USD } from "@/lib/config";
import { hashCode } from "@/lib/invite/code";
import { TONE_KEYS, type Tone } from "@/lib/llm/concepts";
import type { Usage } from "@/lib/llm/cost";
import type { StoredEpisode } from "@/lib/llm/schema";
import type { ChatStats } from "@/lib/stats/compute";
import { type PrivilegedDb, privilegedDb } from "./privileged";

/** episodes 표에서 리포트가 든 행 번호 */
const REPORT_N = 1;

/** 리포트(episodes n = 1 행) 중 앱이 읽는 열 */
export interface ReportRow {
  status: string;
  content: StoredEpisode | null;
  progress: unknown;
  errorCode: string | null;
}

export interface ConversationRow {
  id: string;
  inviteId: string;
  concept: "group" | "couple";
  tone: Tone;
  kind: "pair" | "group" | "work";
  periodStart: string;
  periodEnd: string;
  cutoffAt: string;
  msgTotal: number;
  msgSent: number;
  displayNames: string[];
  stats: ChatStats;
  payloadSha256: string;
  shareTokenHash: string | null;
  expiresAt: string;
  report: ReportRow;
}

export type ClaimOutcome = "created" | "duplicate" | "paused" | "revoked" | "invite_limit" | "global_limit" | "daily_limit";
/** retry_episode 결과. started면 리포트가 running이 됐다 */
export type RetryOutcome = "started" | "paused" | "not_startable" | "retry_limit" | "global_limit";
/** claim_conversation 결과. SQL과 같이 created·duplicate가 아니면 id가 null이다 */
export type ClaimResult =
  | { id: string; outcome: "created" | "duplicate" }
  | { id: null; outcome: Exclude<ClaimOutcome, "created" | "duplicate"> };

export interface AppRepo {
  ping(): Promise<boolean>;
  findInvite(codeHash: string): Promise<{ id: string; revoked: boolean } | null>;
  getInvite(id: string): Promise<{ id: string; revoked: boolean; monthlyLimit: number } | null>;
  findDuplicate(a: { inviteId: string; payloadSha256: string; concept: string; tone: string; promptVersion: string }): Promise<string | null>;
  /**
   * meta 키는 conversations 열 이름: prompt_version, tone, kind, period_start, period_end, cutoff_at, msg_total, msg_sent, display_names, stats.
   * tone은 채우지 않는다(빠지거나 fact·warm·show 밖이면 던진다)
   */
  claim(a: { inviteId: string; concept: string; payloadSha256: string; meta: Record<string, unknown>; estCost: number }): Promise<ClaimResult>;
  /** 만료됐거나 리포트 행(n = 1)이 없는 대화는 null */
  getConversation(id: string): Promise<ConversationRow | null>;
  /** queued·failed·partial 리포트를 running으로 바꾸면 true */
  startReport(id: string): Promise<boolean>;
  /**
   * [다시 쓰기] 판정(retry_episode): paused → not_startable → retry_limit(리포트의 유료 실행 ≥ maxRuns) →
   * global_limit(최근 7일 원가 + 평균 원가 > 주간 상한) → started(startReport)
   */
  retryReport(a: { id: string; estCost: number; maxRuns: number }): Promise<RetryOutcome>;
  /** running 리포트에만 쓴다 */
  saveProgress(id: string, notes: unknown): Promise<void>;
  /**
   * 상태와 상관없이 덮어쓴다. 단 failed인데 앞서 저장한 content가 있으면(partial 다시 쓰기 실패) partial·앞의 content로 두고 errorCode만 바꾼다.
   * usage가 있으면 사용량 원장에 원가를 남긴다(대화가 지워졌어도). 실행 한 번에 한 번만 부른다(usage 한 행 = 유료 실행 한 번)
   */
  finishReport(a: {
    id: string;
    status: string;
    content: unknown;
    model: string | null;
    stopReason: string | null;
    errorCode: string | null;
    usage: Usage | null;
    cost: number;
  }): Promise<void>;
  setPaused(until: Date): Promise<void>;
  /** settings.paused_until. 건 적이 없거나 풀어 두었으면 null. 지난 시각일 수 있다(isPaused로 비교한다) */
  getPausedUntil(): Promise<Date | null>;
  /** 대화·리포트·피드백을 지운다. claim 원장과 사용량 원장은 남는다 */
  deleteConversation(id: string, inviteId: string): Promise<boolean>;
  /**
   * 공유 토큰 해시를 쓴다(null이면 폐기). `expectHash`를 주면 지금 토큰 해시가 그 값(null 포함)일 때만 쓴다(읽고 쓰는 사이의 폐기·중복 발급을 막는다).
   * 안 주면 무조건 쓴다(폐기용). 대화가 없거나 조건이 안 맞으면 false
   */
  setShare(id: string, inviteId: string, share: { tokenHash: string | null; expectHash?: string | null }): Promise<boolean>;
  getByShareHash(hash: string): Promise<ConversationRow | null>;
  addFeedback(a: { id: string; paragraphKey: string; reason: string }): Promise<void>;
}

/** 지금(now ms) 새 생성을 멈춰 둔 상태인가. claim_conversation의 paused 판정(paused_until > now())과 같은 비교다 */
export async function isPaused(repo: AppRepo, now: number): Promise<boolean> {
  const until = await repo.getPausedUntil();
  return until !== null && until.getTime() > now;
}

/** 프로덕션인데 DB 키가 없다. 라우트가 503으로 바꾼다 */
export class NotReadyError extends Error {
  readonly status = 503;
}

// ===== memoryRepo =====

const DAY_MS = 86_400_000;
const SEOUL_OFFSET_MS = 9 * 3_600_000; // Asia/Seoul은 서머타임이 없다
const STATUSES = new Set(["queued", "running", "done", "partial", "failed", "refused", "safety"]);
const STARTABLE = new Set(["queued", "failed", "partial"]);
/** 평균 원가 표본에서 '끝난' 리포트 */
const FINISHED = new Set(["done", "partial", "refused", "safety"]);
const CONCEPTS = new Set(["group", "couple"]);
const TONES = new Set<string>(TONE_KEYS);
const KINDS = new Set(["pair", "group", "work"]);
const FEEDBACK_REASONS = new Set(["wrong_person", "wrong_fact", "tone", "other"]);

/** cost_usd_est numeric(10,4)처럼 1만분의 1달러 정수로 들고 있어 합계가 정확하다 */
const toUnits = (usd: number) => Math.round(usd * 10_000);
/** ms → 서울 날짜(그날 0시 UTC의 ms로 나타낸다) */
function seoulDay(ms: number): number {
  const d = new Date(ms + SEOUL_OFFSET_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
/** 서울 날짜 → 그날 서울 0시의 ms */
const seoulMidnight = (day: number) => day - SEOUL_OFFSET_MS;
/** analytalk.cycle_start: day 이하에서 가장 가까운 anchor 일 */
function cycleStart(day: number, anchor: number): number {
  const shifted = new Date(day - (anchor - 1) * DAY_MS);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) + (anchor - 1) * DAY_MS;
}
function plusMonth(day: number): number {
  const d = new Date(day);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}
/** jsonb ->> 처럼 문자열로. 없거나 JSON null이면 null */
const text = (v: unknown): string | null =>
  v == null ? null : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
const num = (v: unknown): number | null => (v == null ? null : Number(v));
/** timestamptz 값은 두 저장소 모두 ISO(UTC) 문자열로 돌려준다. 시각이 아니면 SQL 캐스트처럼 던진다 */
const isoOf = (v: unknown): string | null => (v == null ? null : new Date(text(v) as string).toISOString());
const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

/** 리포트 행(episodes n = 1) 중 규칙과 ConversationRow가 읽는 열만 둔다(model_served·stop_reason·started_at·finished_at은 읽는 곳이 없다) */
interface MemReport {
  status: string;
  content: unknown;
  progress: unknown;
  errorCode: string | null;
}

interface MemConversation {
  id: string;
  inviteId: string;
  concept: string;
  tone: string;
  kind: string | null;
  promptVersion: string;
  periodStart: string | null;
  periodEnd: string | null;
  cutoffAt: string | null;
  msgTotal: number | null;
  msgSent: number | null;
  displayNames: unknown;
  stats: unknown;
  payloadSha256: string;
  shareTokenHash: string | null;
  createdAt: number;
  expiresAt: number;
  report: MemReport;
}

function toRow(c: MemConversation): ConversationRow {
  return clone({
    id: c.id,
    inviteId: c.inviteId,
    concept: c.concept,
    tone: c.tone,
    kind: c.kind,
    periodStart: c.periodStart,
    periodEnd: c.periodEnd,
    cutoffAt: c.cutoffAt,
    msgTotal: c.msgTotal,
    msgSent: c.msgSent,
    displayNames: c.displayNames,
    stats: c.stats,
    payloadSha256: c.payloadSha256,
    shareTokenHash: c.shareTokenHash,
    expiresAt: new Date(c.expiresAt).toISOString(),
    report: { status: c.report.status, content: c.report.content, progress: c.report.progress, errorCode: c.report.errorCode },
  }) as ConversationRow;
}

/** DB 규칙을 TS로 재현한 저장소. 시각은 Date.now()가 DB의 now()다. pg_cron(fail_stale_episodes·purge_expired)은 돌리지 않는다 */
export function memoryRepo(seed: { invites?: { code: string; monthlyLimit: number; revoked?: boolean }[] } = {}): AppRepo {
  const invites = new Map<string, { id: string; codeHash: string; monthlyLimit: number; revoked: boolean }>();
  for (const invite of seed.invites ?? []) {
    const id = randomUUID();
    invites.set(id, { id, codeHash: hashCode(invite.code), monthlyLimit: invite.monthlyLimit, revoked: invite.revoked ?? false });
  }
  const conversations = new Map<string, MemConversation>();
  /** analytalk.claims. 대화가 지워지면 conversationId만 null이 되고 excluded는 마지막 값으로 굳는다 */
  const claims: { inviteId: string; conversationId: string | null; createdAt: number; excluded: boolean }[] = [];
  /** analytalk.usage_events 중 규칙이 읽는 열. 앱 행뿐이고 모두 리포트(n = 1)의 실행이다 */
  const usage: { conversationId: string | null; at: number; costUnits: number }[] = [];
  let pausedUntil: number | null = null;

  const live = (c: MemConversation, now: number) => c.expiresAt > now;
  const reportOf = (id: string) => conversations.get(id)?.report;
  const sumUnits = (rows: { costUnits: number }[]) => rows.reduce((s, u) => s + u.costUnits, 0);
  /** start_episode: content는 그대로 둔다(finish_episode가 덮어쓴다) */
  const start = (r: MemReport) => Object.assign(r, { status: "running", errorCode: null, progress: null });

  /** episodes_sync_claim 트리거: 리포트가 refused이거나 error_code = 'limit'이면 원장에서 뺀다 */
  function syncExcluded(id: string) {
    const c = conversations.get(id);
    if (!c) return;
    const excluded = c.report.status === "refused" || c.report.errorCode === "limit";
    for (const k of claims) if (k.conversationId === id) k.excluded = excluded;
  }

  /** find_duplicate: 만료 안 된 같은 요청(코드·payload·컨셉·말투·프롬프트 버전) 중 가장 최근 것. SQL의 = null처럼 null 키는 맞지 않는다 */
  function duplicateOf(
    a: { inviteId: string; sha: string; concept: string; tone: string | null; promptVersion: string | null },
    now: number,
  ): string | null {
    let best: MemConversation | null = null;
    for (const c of conversations.values()) {
      if (c.inviteId !== a.inviteId || c.payloadSha256 !== a.sha || c.concept !== a.concept) continue;
      if (a.tone === null || c.tone !== a.tone) continue;
      if (a.promptVersion === null || c.promptVersion !== a.promptVersion || !live(c, now)) continue;
      if (!best || c.createdAt >= best.createdAt) best = c;
    }
    return best?.id ?? null;
  }

  /** 진행 중 대화: 리포트가 running이거나, queued이고 만든 지 24시간 안 */
  function inProgressCount(now: number): number {
    let count = 0;
    for (const c of conversations.values()) {
      if (!live(c, now)) continue;
      const { status } = c.report;
      if (status === "running" || (status === "queued" && c.createdAt > now - DAY_MS)) count++;
    }
    return count;
  }

  /** avg_conversation_cost: 최근 30일에 만든 대화 중 리포트가 끝난 대화의 대화당 원가 평균(1만분의 1달러). 표본 3건 미만이거나 0 이하면 추정값 */
  function averageUnits(now: number, estCost: number): number {
    const samples = [...conversations.values()].filter((c) => c.createdAt >= now - 30 * DAY_MS && FINISHED.has(c.report.status));
    const avg = samples.length ? samples.reduce((s, c) => s + sumUnits(usage.filter((u) => u.conversationId === c.id)), 0) / samples.length : 0;
    return samples.length < 3 || avg <= 0 ? estCost * 10_000 : avg;
  }

  return {
    async ping() {
      return true;
    },

    async findInvite(codeHash) {
      for (const invite of invites.values()) if (invite.codeHash === codeHash) return { id: invite.id, revoked: invite.revoked };
      return null;
    },

    async getInvite(id) {
      const invite = invites.get(id);
      return invite ? { id: invite.id, revoked: invite.revoked, monthlyLimit: invite.monthlyLimit } : null;
    },

    async findDuplicate(a) {
      return duplicateOf({ inviteId: a.inviteId, sha: a.payloadSha256, concept: a.concept, tone: a.tone, promptVersion: a.promptVersion }, Date.now());
    },

    // claim_conversation: 1 duplicate → 2 paused → 3 revoked → 4 invite_limit → 5 global_limit → 6 daily_limit → 7 created.
    // await가 없어 한 번에 끝난다(SQL의 advisory lock과 같은 효과)
    async claim(a) {
      if (!(a.estCost > 0)) throw new Error("[memoryRepo] invalid est cost");
      const now = Date.now();
      const promptVersion = text(a.meta.prompt_version);
      const tone = text(a.meta.tone);

      const duplicate = duplicateOf({ inviteId: a.inviteId, sha: a.payloadSha256, concept: a.concept, tone, promptVersion }, now);
      if (duplicate) return { id: duplicate, outcome: "duplicate" };
      if (pausedUntil !== null && pausedUntil > now) return { id: null, outcome: "paused" };
      const invite = invites.get(a.inviteId);
      if (!invite || invite.revoked) return { id: null, outcome: "revoked" };

      const today = seoulDay(now);
      const cycle = cycleStart(today, CYCLE_ANCHOR_DAY);
      const cycleFrom = seoulMidnight(cycle);
      const daysLeft = Math.round((plusMonth(cycle) - today) / DAY_MS);

      const used = claims.filter((k) => k.inviteId === a.inviteId && k.createdAt >= cycleFrom && !k.excluded).length;
      if (used >= invite.monthlyLimit) return { id: null, outcome: "invite_limit" };

      const avg = averageUnits(now, a.estCost);
      const inProgress = inProgressCount(now);
      const weekUnits = sumUnits(usage.filter((u) => u.at > now - 7 * DAY_MS));
      if (weekUnits + (inProgress + 1) * avg > toUnits(WEEKLY_CAP_USD)) return { id: null, outcome: "global_limit" };

      const cycleUnits = sumUnits(usage.filter((u) => u.at >= cycleFrom));
      const todayCount = claims.filter((k) => k.createdAt >= seoulMidnight(today)).length;
      const perDay = Math.floor((toUnits(MONTHLY_BUDGET_USD) - cycleUnits - inProgress * avg) / daysLeft / avg);
      if (todayCount >= perDay) return { id: null, outcome: "daily_limit" };

      // 열 제약(check·not null)을 넣기 전에 확인한다. 걸리면 SQL처럼 아무것도 만들지 않는다
      const kind = text(a.meta.kind);
      if (!CONCEPTS.has(a.concept) || (kind !== null && !KINDS.has(kind))) throw new Error("[memoryRepo] concept/kind check");
      // tone not null + check(fact·warm·show). SQL처럼 기본값으로 채우지 않는다
      if (tone === null || !TONES.has(tone)) throw new Error("[memoryRepo] tone check");
      if (promptVersion === null || a.meta.display_names == null || a.meta.stats == null) {
        throw new Error("[memoryRepo] prompt_version/display_names/stats not null");
      }
      const id = randomUUID();
      conversations.set(id, {
        id,
        inviteId: a.inviteId,
        concept: a.concept,
        tone,
        kind,
        promptVersion,
        periodStart: text(a.meta.period_start),
        periodEnd: text(a.meta.period_end),
        cutoffAt: isoOf(a.meta.cutoff_at),
        msgTotal: num(a.meta.msg_total),
        msgSent: num(a.meta.msg_sent),
        displayNames: clone(a.meta.display_names),
        stats: clone(a.meta.stats),
        payloadSha256: a.payloadSha256,
        shareTokenHash: null,
        createdAt: now,
        expiresAt: now + RETENTION_DAYS * DAY_MS,
        report: { status: "queued", content: null, progress: null, errorCode: null },
      });
      claims.push({ inviteId: a.inviteId, conversationId: id, createdAt: now, excluded: false });
      return { id, outcome: "created" };
    },

    async getConversation(id) {
      const c = conversations.get(id);
      return c && live(c, Date.now()) ? toRow(c) : null;
    },

    async startReport(id) {
      const r = reportOf(id);
      if (!r || !STARTABLE.has(r.status)) return false;
      start(r);
      syncExcluded(id);
      return true;
    },

    // retry_episode: claim과 같이 await 없이 한 번에 판정하고 시작한다. 이번 실행 몫은 평균 원가 전체다(따라 도는 편이 없다)
    async retryReport(a) {
      if (!(a.estCost > 0) || !(a.maxRuns >= 1)) throw new Error("[memoryRepo] invalid retry args");
      const now = Date.now();
      if (pausedUntil !== null && pausedUntil > now) return "paused";
      const c = conversations.get(a.id);
      if (!c || !live(c, now) || !STARTABLE.has(c.report.status)) return "not_startable";
      if (usage.filter((u) => u.conversationId === a.id).length >= a.maxRuns) return "retry_limit";
      const weekUnits = sumUnits(usage.filter((u) => u.at > now - 7 * DAY_MS));
      if (weekUnits + averageUnits(now, a.estCost) > toUnits(WEEKLY_CAP_USD)) return "global_limit";
      start(c.report);
      syncExcluded(a.id);
      return "started";
    },

    async saveProgress(id, notes) {
      const r = reportOf(id);
      if (r?.status === "running") r.progress = clone(notes);
    },

    async finishReport(a) {
      if (!STATUSES.has(a.status)) throw new Error("[memoryRepo] episode status check");
      const now = Date.now();
      const c = conversations.get(a.id);
      if (c) {
        // partial 다시 쓰기가 실패하면 앞의 글을 남긴다(finish_episode와 같다)
        const keep = a.status === "failed" && c.report.content != null;
        Object.assign(c.report, {
          status: keep ? "partial" : a.status,
          content: keep ? c.report.content : clone(a.content),
          errorCode: a.errorCode,
        });
        syncExcluded(a.id);
      }
      if (a.usage !== null && typeof a.usage === "object") {
        usage.push({ conversationId: c ? c.id : null, at: now, costUnits: toUnits(a.cost) });
      }
    },

    async setPaused(until) {
      pausedUntil = until.getTime();
    },

    async getPausedUntil() {
      return pausedUntil === null ? null : new Date(pausedUntil);
    },

    async deleteConversation(id, inviteId) {
      const c = conversations.get(id);
      if (!c || c.inviteId !== inviteId) return false;
      conversations.delete(id);
      for (const u of usage) if (u.conversationId === id) u.conversationId = null;
      for (const k of claims) if (k.conversationId === id) k.conversationId = null;
      return true;
    },

    async setShare(id, inviteId, share) {
      const c = conversations.get(id);
      if (!c || c.inviteId !== inviteId || !live(c, Date.now())) return false;
      if (share.expectHash !== undefined && c.shareTokenHash !== share.expectHash) return false;
      if (share.tokenHash !== null) {
        for (const other of conversations.values()) {
          if (other.id !== id && other.shareTokenHash === share.tokenHash) throw new Error("[memoryRepo] share_token_hash unique");
        }
      }
      c.shareTokenHash = share.tokenHash;
      return true;
    },

    async getByShareHash(hash) {
      const now = Date.now();
      for (const c of conversations.values()) if (c.shareTokenHash === hash && live(c, now)) return toRow(c);
      return null;
    },

    // 피드백을 읽는 API가 없어 제약(이유 check·대화 FK)만 확인하고 버린다
    async addFeedback(a) {
      if (!FEEDBACK_REASONS.has(a.reason)) throw new Error("[memoryRepo] feedback reason check");
      if (!conversations.has(a.id)) throw new Error("[memoryRepo] feedback conversation fk");
    },
  };
}

// ===== Supabase =====

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PostgREST 오류는 코드만 남긴다. details에 행 값(표시 이름·통계)이 들어갈 수 있다 */
function check<T>(op: string, r: { data: T; error: { code?: string } | null }): T {
  if (r.error) throw new Error(`[repo] ${op} 실패 (${r.error.code ?? "unknown"})`);
  return r.data;
}

// share_scope·share_hidden은 v1 호환으로 남긴 열이라 읽지 않는다. 남은 v1 대화의 2~4편 행도 임베드에 오지만 fromDb가 버린다
const CONVERSATION_COLUMNS =
  "id, invite_id, concept, tone, kind, period_start, period_end, cutoff_at, msg_total, msg_sent, display_names, stats, payload_sha256, " +
  "share_token_hash, expires_at, episodes(n, status, content, progress, error_code)";

interface DbConversation {
  id: string;
  invite_id: string;
  concept: ConversationRow["concept"];
  tone: Tone;
  kind: ConversationRow["kind"];
  period_start: string;
  period_end: string;
  cutoff_at: string;
  msg_total: number;
  msg_sent: number;
  display_names: string[];
  stats: ChatStats;
  payload_sha256: string;
  share_token_hash: string | null;
  expires_at: string;
  episodes: { n: number; status: string; content: StoredEpisode | null; progress: unknown; error_code: string | null }[];
}

/** 리포트 행(n = 1)이 없으면 null */
function fromDb(row: DbConversation): ConversationRow | null {
  const report = row.episodes.find((e) => e.n === REPORT_N);
  if (!report) return null;
  return {
    id: row.id,
    inviteId: row.invite_id,
    concept: row.concept,
    tone: row.tone,
    kind: row.kind,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    cutoffAt: isoOf(row.cutoff_at) as string,
    msgTotal: row.msg_total,
    msgSent: row.msg_sent,
    displayNames: row.display_names,
    stats: row.stats,
    payloadSha256: row.payload_sha256,
    shareTokenHash: row.share_token_hash,
    expiresAt: isoOf(row.expires_at) as string,
    report: { status: report.status, content: report.content, progress: report.progress, errorCode: report.error_code },
  };
}

function supabaseRepo(db: PrivilegedDb): AppRepo {
  const nowIso = () => new Date().toISOString();
  const conversations = () => db.from("conversations");
  return {
    async ping() {
      const { data, error } = await db.rpc("healthcheck");
      return !error && data === "ok";
    },

    async findInvite(codeHash) {
      const data = check("findInvite", await db.from("invites").select("id, revoked_at").eq("code_hash", codeHash).maybeSingle());
      return data ? { id: data.id, revoked: data.revoked_at !== null } : null;
    },

    async getInvite(id) {
      if (!UUID.test(id)) return null;
      const data = check("getInvite", await db.from("invites").select("id, revoked_at, monthly_limit").eq("id", id).maybeSingle());
      return data ? { id: data.id, revoked: data.revoked_at !== null, monthlyLimit: data.monthly_limit } : null;
    },

    async findDuplicate(a) {
      const data = check(
        "findDuplicate",
        await db.rpc("find_duplicate", {
          p_invite_id: a.inviteId,
          p_payload_sha256: a.payloadSha256,
          p_concept: a.concept,
          p_tone: a.tone,
          p_prompt_version: a.promptVersion,
        }),
      );
      return (data as string | null) ?? null;
    },

    async claim(a) {
      const rows = check(
        "claim",
        await db.rpc("claim_conversation", {
          p_invite_id: a.inviteId,
          p_concept: a.concept,
          p_payload_sha256: a.payloadSha256,
          p_meta: a.meta,
          p_est_cost: a.estCost,
        }),
      ) as { out_id: string | null; out_outcome: ClaimOutcome }[];
      return { id: rows[0].out_id, outcome: rows[0].out_outcome } as ClaimResult;
    },

    async getConversation(id) {
      if (!UUID.test(id)) return null;
      const data = check(
        "getConversation",
        await conversations().select(CONVERSATION_COLUMNS).eq("id", id).gt("expires_at", nowIso()).maybeSingle(),
      );
      return data ? fromDb(data as unknown as DbConversation) : null;
    },

    async startReport(id) {
      if (!UUID.test(id)) return false;
      return check("startReport", await db.rpc("start_episode", { p_id: id, p_n: REPORT_N })) === true;
    },

    async retryReport(a) {
      if (!UUID.test(a.id)) return "not_startable";
      return check(
        "retryReport",
        await db.rpc("retry_episode", { p_id: a.id, p_n: REPORT_N, p_est_cost: a.estCost, p_max_runs: a.maxRuns }),
      ) as RetryOutcome;
    },

    async saveProgress(id, notes) {
      check("saveProgress", await db.rpc("save_progress", { p_id: id, p_n: REPORT_N, p_notes: notes }));
    },

    async finishReport(a) {
      check(
        "finishReport",
        await db.rpc("finish_episode", {
          p_id: a.id,
          p_n: REPORT_N,
          p_status: a.status,
          p_content: a.content,
          p_model: a.model,
          p_stop_reason: a.stopReason,
          p_error_code: a.errorCode,
          p_usage: a.usage,
          p_cost: a.cost,
        }),
      );
    },

    async setPaused(until) {
      check("setPaused", await db.rpc("set_paused", { p_until: until.toISOString() }));
    },

    async getPausedUntil() {
      const data = check("getPausedUntil", await db.from("settings").select("paused_until").eq("id", 1).maybeSingle()) as {
        paused_until: string | null;
      } | null;
      const iso = isoOf(data?.paused_until);
      return iso === null ? null : new Date(iso);
    },

    async deleteConversation(id, inviteId) {
      if (!UUID.test(id)) return false;
      const data = check("deleteConversation", await conversations().delete().eq("id", id).eq("invite_id", inviteId).select("id"));
      return (data ?? []).length > 0;
    },

    async setShare(id, inviteId, share) {
      if (!UUID.test(id)) return false;
      // 발급 때 scope 'all'·hidden []도 써 둔다: v1 코드로 되돌려도 링크가 살아 있고 숨김이 없다
      const values = share.tokenHash === null ? { share_token_hash: null } : { share_token_hash: share.tokenHash, share_scope: "all", share_hidden: [] };
      let query = conversations()
        .update(values)
        .eq("id", id)
        .eq("invite_id", inviteId)
        .gt("expires_at", nowIso());
      if (share.expectHash === null) query = query.is("share_token_hash", null);
      else if (share.expectHash !== undefined) query = query.eq("share_token_hash", share.expectHash);
      const data = check("setShare", await query.select("id"));
      return (data ?? []).length > 0;
    },

    async getByShareHash(hash) {
      const data = check(
        "getByShareHash",
        await conversations().select(CONVERSATION_COLUMNS).eq("share_token_hash", hash).gt("expires_at", nowIso()).maybeSingle(),
      );
      return data ? fromDb(data as unknown as DbConversation) : null;
    },

    async addFeedback(a) {
      check(
        "addFeedback",
        await db.from("feedback").insert({ conversation_id: a.id, n: REPORT_N, paragraph_key: a.paragraphKey, reason: a.reason }),
      );
    },
  };
}

// ===== 선택 =====

// 개발 서버가 다시 컴파일돼도 memoryRepo가 유지되게 전역에 둔다. 저장소 모양이 바뀌면 키 버전을 올린다
// V2: getPausedUntil 추가, V3: retryEpisode 추가, V4: 리포트 한 행(startReport·finishReport…)·tone
const memory = globalThis as unknown as { analytalkRepoV4?: AppRepo; analytalkDevRepoV4?: AppRepo };

/** E2E → 고정 코드 memoryRepo, secret 키 있음 → Supabase, 개발에서 키 없음 → memoryRepo, 프로덕션에서 키 없음 → NotReadyError(503) */
export function getRepo(): AppRepo {
  if (isE2E()) return (memory.analytalkRepoV4 ??= memoryRepo({ invites: [{ code: E2E_INVITE_CODE, monthlyLimit: 99 }] }));
  const db = privilegedDb();
  if (db) return supabaseRepo(db);
  if (process.env.NODE_ENV === "production") throw new NotReadyError("Supabase secret 키가 없다");
  return (memory.analytalkDevRepoV4 ??= memoryRepo());
}
