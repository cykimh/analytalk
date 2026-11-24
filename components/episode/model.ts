// 대화 홈·진행·편 화면의 순수 로직(API 응답 → 화면 상태·문구). DOM 없이 테스트한다.
import { formatCount, formatDuration, formatPercent, kstDate, topPeople } from "@/components/stats/format";
import type { StoredEpisode } from "@/lib/llm/schema";
import type { ChatStats } from "@/lib/stats/compute";

/** GET /api/conversations/[id] */
export interface ConversationView {
  concept: "group" | "couple";
  kind: "pair" | "group" | "work";
  displayNames: string[];
  stats: ChatStats;
  /** transcript 첫 메시지 시각(ISO) */
  cutoffAt: string;
  msgSent: number;
  /** 자동 삭제 시각(ISO) */
  expiresAt: string;
  episodes: { n: number; status: string; content: StoredEpisode | null; errorCode: string | null }[];
}

/** GET /api/conversations/[id]/status */
export interface StatusView {
  episodes: { n: number; status: string; progress: unknown; errorCode: string | null }[];
  /** 전역 정지 중(새 생성·다시 쓰기가 423) */
  paused: boolean;
}

export type Note = { range: string; note: string };
type EpisodeState = { n: number; status: string };

export const STATUS_TEXT: Record<string, string> = {
  queued: "기다리는 중",
  running: "쓰는 중",
  done: "다 썼어요",
  partial: "일부만 썼어요",
  failed: "쓰지 못했어요",
  refused: "AI가 이 편은 쓰지 않았어요",
  safety: "이 편은 쓰지 않았어요",
};

/** safety 편(도움 안내). 어느 신호였는지는 저장하지 않아 한 문구로 안내한다 */
export const SAFETY_HELP =
  "걱정되는 이야기가 보여서 이 편은 쓰지 않았어요. 힘들 때는 109(자살예방상담전화, 24시간), 위험할 때는 112·1366(여성긴급전화, 24시간)에서 도와줘요.";
export const AI_NOTICE = "AI 생성, 재미·참고용";
export const PAUSED_TEXT = "이번 달 AI 마감";

const statusOf = (episodes: EpisodeState[], n: number) => episodes.find((e) => e.n === n)?.status;

/**
 * 서버가 지금 쓰고 있거나 곧 쓸 편이 있다(폴링을 계속한다).
 * 1편이 실패·거절되면 2~4편은 queued로 남아 [다시 쓰기]를 기다리므로 진행 중으로 보지 않는다
 */
export function isActive(episodes: EpisodeState[]): boolean {
  if (episodes.some((e) => e.status === "running")) return true;
  const first = statusOf(episodes, 1);
  return episodes.some((e) => e.status === "queued") && (first === "queued" || first === "done" || first === "partial");
}

/** 페이로드를 다시 쓸 편(queued·running·failed·partial)이 없다. 이 브라우저의 페이로드를 지운다 */
const NEEDS_PAYLOAD = new Set(["queued", "running", "failed", "partial"]);
export const isSettled = (episodes: EpisodeState[]) => episodes.length > 0 && episodes.every((e) => !NEEDS_PAYLOAD.has(e.status));

/** 상태가 달라진 편이 있다(대화 내용을 다시 읽는다) */
export function statusChanged(conversation: EpisodeState[], status: EpisodeState[]): boolean {
  return conversation.length !== status.length || status.some((e) => statusOf(conversation, e.n) !== e.status);
}

const isNote = (v: unknown): v is Note =>
  typeof v === "object" && v !== null && typeof (v as Note).range === "string" && typeof (v as Note).note === "string";

/**
 * 편별로 지금까지 본 reading_notes에 새로 온 메모를 붙인다(같은 메모는 한 번). 바뀐 것이 없으면 prev를 그대로 돌려준다.
 * 다시 쓰기가 시작돼 progress가 비어도 쌓인 메모는 남는다
 */
export function mergeEpisodeNotes(prev: Record<number, Note[]>, episodes: { n: number; progress: unknown }[]): Record<number, Note[]> {
  let next = prev;
  for (const e of episodes) {
    if (!Array.isArray(e.progress)) continue;
    const seen = next[e.n] ?? [];
    const fresh = e.progress.filter(isNote).filter((a) => !seen.some((b) => b.range === a.range && b.note === a.note));
    if (fresh.length === 0) continue;
    next = { ...next, [e.n]: [...seen, ...fresh.map(({ range, note }) => ({ range, note }))] };
  }
  return next;
}

/** ISO 시각 → KST 날짜 YYYY-MM-DD */
export const kstDay = (iso: string) => kstDate(Date.parse(iso));

/** ISO 시각 → KST "YYYY-MM-DD HH:mm". 시각이 아니면 빈 글자 */
export function formatAt(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "";
  const d = new Date(ts + 9 * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${kstDate(ts)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** 읽은 범위 "YYYY-MM-DD 이후 N개" */
export const readRange = (cutoffAt: string, msgSent: number) => `${kstDay(cutoffAt)} 이후 ${formatCount(msgSent)}개`;

/** 편 카드의 버튼: 내용이 있으면 [읽기], failed·partial이면 [다시 쓰기](정지 중이면 마감 안내) */
export function episodeAction(status: string, paused: boolean): { read: boolean; retry: "button" | "paused" | null } {
  const read = status === "done" || status === "partial";
  const retryable = status === "failed" || status === "partial";
  return { read, retry: retryable ? (paused ? "paused" : "button") : null };
}

const REPLY_CARD_PEOPLE = 2;

/** 진행 화면에서 AI가 생각하는 동안 돌아가며 보여 줄 통계(값이 없는 카드는 뺀다) */
export function statCards(stats: ChatStats): { label: string; value: string }[] {
  const { people } = topPeople(stats, REPLY_CARD_PEOPLE);
  const top = people[0];
  const cards = [{ label: "메시지", value: `${formatCount(stats.total)}개` }];
  if (top) cards.push({ label: "가장 많이 보낸 사람", value: `${top} · ${formatPercent(stats.share[top] ?? 0)}` });
  cards.push({ label: "최장 연속", value: `${formatCount(stats.longestStreakDays)}일` });
  if (stats.busiestDay) {
    cards.push({ label: "가장 많았던 날", value: `${stats.busiestDay.date} · ${formatCount(stats.busiestDay.count)}개` });
  }
  cards.push({ label: "심야 비율 (22~5시)", value: formatPercent(stats.nightRatio) });
  for (const p of people) {
    const ms = stats.replyMedianMs[p];
    if (ms !== null && ms !== undefined) cards.push({ label: `${p}의 답장 간격`, value: formatDuration(ms) });
  }
  return cards;
}
