// 리포트 맨 위 '하이라이트 한 줄 카드'(v2.8). 코드가 통계(ChatStats)로 만든다(AI 비용 없음). 리포트 읽기·공유·데모 화면이 표지 폴라로이드 아래에 그린다.
// 카드는 재미있는 순서(아래 순서)로 보고, 숫자가 의미 없으면(0·데이터 부족) 그 카드는 빼고 HIGHLIGHT_RULES.maxCards장까지 고른다.
// 케미 온도만 AI가 매긴 값이다(인트로 호출의 chemistry, 검증을 거친 것). 없으면(예전 리포트) 그 카드만 빠진다.
// v2.9: 사람을 견주는 카드(먼저 말 걸기·ㅋ 폭격기·답장 제일 빠른 사람·물음표·사진)는 '누가 더 ___' 칭호(titles.ts)로 옮기고,
//   여기는 방 전체 숫자만 남긴다. 숫자 카드(답장 속도·새벽 대화·가장 수다스러운 시간)에는 재치 한 줄(quips.ts)을 단다.
// 가장 뜨거웠던 날은 폴라로이드(KpiPolaroids)에 이미 있어 카드로 만들지 않는다.
import { formatCount, formatDuration, formatPercent, periodOf } from "@/components/stats/format";
import type { ChatStats } from "./compute";
import { hourLabel, NIGHT_RANGE, nightQuip, peakHour, peakQuip, replyQuip } from "./quips";

export interface HighlightCard {
  key: "chemistry" | "reply" | "night" | "peak" | "streak" | "daily";
  /** 이모지 하나(장식) */
  emoji: string;
  label: string;
  value: string;
  /** 숫자 아래 재치 한 줄(코드가 고른 고정 문구) */
  quip?: string;
  /** 케미 온도의 한 줄(모델이 쓴 글, {{stat:…}}이 있을 수 있다) */
  note?: string;
}

export const HIGHLIGHT_RULES = {
  maxCards: 6,
  /** 새벽 대화 비율 하한 */
  minNightRatio: 0.05,
  /** 가장 수다스러운 시간을 낼 메시지 수 하한 */
  minPeakMessages: 30,
  minStreakDays: 3,
  /** 하루 평균을 낼 기간(첫 메시지 ~ 마지막 메시지, 양 끝 포함) 하한 */
  minPeriodDays: 2,
} as const;

type Chemistry = { score: number; line: string } | null | undefined;

/** 케미 온도: 0~100 정수일 때만 */
function chemistryCard(c: Chemistry): HighlightCard | null {
  if (!c || !Number.isInteger(c.score) || c.score < 0 || c.score > 100) return null;
  const line = typeof c.line === "string" ? c.line.trim() : "";
  return { key: "chemistry", emoji: "🌡️", label: "케미 온도", value: `${c.score}°`, note: line === "" ? undefined : line };
}

/** 답장 속도(방 전체 답장 간격의 중앙값, v2.9 통계. 예전 통계에는 없다) */
function replyCard(s: ChatStats): HighlightCard | null {
  const quip = replyQuip(s.replyMedianAll);
  if (quip === null) return null;
  return { key: "reply", emoji: "⚡", label: "답장 속도(방 전체 중앙값)", value: formatDuration(s.replyMedianAll!), quip };
}

function nightCard(s: ChatStats): HighlightCard | null {
  if (!(s.nightRatio >= HIGHLIGHT_RULES.minNightRatio)) return null;
  return { key: "night", emoji: "🌙", label: `새벽 대화(${NIGHT_RANGE})`, value: formatPercent(s.nightRatio), quip: nightQuip(s.nightRatio) };
}

function peakCard(s: ChatStats): HighlightCard | null {
  const total = s.hourHistogram.reduce((a, b) => a + b, 0);
  const h = peakHour(s.hourHistogram);
  if (h === null || total < HIGHLIGHT_RULES.minPeakMessages) return null;
  return { key: "peak", emoji: "⏰", label: "가장 수다스러운 시간", value: hourLabel(h), quip: peakQuip(h) };
}

function streakCard(s: ChatStats): HighlightCard | null {
  if (!(s.longestStreakDays >= HIGHLIGHT_RULES.minStreakDays)) return null;
  return { key: "streak", emoji: "🔥", label: "최장 연속 대화", value: `${formatCount(s.longestStreakDays)}일` };
}

function dailyCard(s: ChatStats): HighlightCard | null {
  const period = periodOf(s.dailyCounts);
  if (!period || period.days < HIGHLIGHT_RULES.minPeriodDays) return null;
  const avg = Math.round(s.total / period.days);
  if (avg < 1) return null;
  return { key: "daily", emoji: "📅", label: "하루 평균", value: `${formatCount(avg)}개` };
}

/** 하이라이트 카드(많아야 HIGHLIGHT_RULES.maxCards장) */
export function highlightCards(stats: ChatStats, opts: { chemistry?: Chemistry } = {}): HighlightCard[] {
  const cards = [chemistryCard(opts.chemistry), replyCard(stats), nightCard(stats), peakCard(stats), streakCard(stats), dailyCard(stats)];
  return cards.filter((c): c is HighlightCard => c !== null).slice(0, HIGHLIGHT_RULES.maxCards);
}
