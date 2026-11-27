// 리포트 맨 위 '하이라이트 한 줄 카드'(v2.8). 코드가 통계(ChatStats)로 만든다(AI 비용 없음). 리포트 읽기·공유·데모 화면이 표지 폴라로이드 아래에 그린다.
// 카드는 재미있는 순서(아래 CARDS 순서)로 보고, 숫자가 의미 없으면(0·데이터 부족) 그 카드는 빼고 HIGHLIGHT_RULES.maxCards장까지 고른다.
// 케미 온도만 AI가 매긴 값이다(인트로 호출의 chemistry, 검증을 거친 것). 없으면(예전 리포트) 그 카드만 빠진다.
// 가장 뜨거웠던 날은 폴라로이드(KpiPolaroids)에 이미 있어 카드로 만들지 않는다.
// 사람 이름은 stats의 키(뺀 멤버는 처음부터 없다)이고, 글은 화면이 React 텍스트 노드로만 그린다.
import { formatCount, formatDuration, formatPercent, periodOf } from "@/components/stats/format";
import { NIGHT_END, NIGHT_START } from "@/lib/config";
import type { ChatStats } from "./compute";

export interface HighlightCard {
  key: "chemistry" | "initiations" | "laugh" | "night" | "reply" | "streak" | "daily" | "question" | "photo";
  /** 이모지 하나(장식) */
  emoji: string;
  label: string;
  value: string;
  /** 케미 온도의 한 줄(모델이 쓴 글, {{stat:…}}이 있을 수 있다) */
  note?: string;
}

export const HIGHLIGHT_RULES = {
  maxCards: 6,
  /** 먼저 말 걸기(6시간 공백 뒤 첫 메시지)가 모두 합쳐 이만큼은 돼야 비율을 보인다 */
  minInitiations: 5,
  /** ㅋ 폭격기 1위의 ㅋ 글자 수 하한 */
  minLaughChars: 10,
  /** 새벽 대화 비율 하한 */
  minNightRatio: 0.05,
  /** 답장 속도를 견줄 사람의 메시지 수 하한(그런 사람이 둘 이상이어야 한다) */
  minReplyMessages: 10,
  minStreakDays: 3,
  /** 하루 평균을 낼 기간(첫 메시지 ~ 마지막 메시지, 양 끝 포함) 하한 */
  minPeriodDays: 2,
  /** 물음표 비율을 견줄 사람의 메시지 수 하한 */
  minQuestionMessages: 20,
  minPhotos: 5,
} as const;

type Chemistry = { score: number; line: string } | null | undefined;

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** 값이 큰 순서(동률은 이름 순)의 [이름, 값] */
function ranked(rec: Record<string, number | null | undefined> | undefined, keep: (name: string, v: number) => boolean = () => true): [string, number][] {
  return Object.entries(rec ?? {})
    .filter((e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1]) && keep(e[0], e[1]))
    .sort(([a, x], [b, y]) => y - x || byName(a, b));
}
const nightLabel = `새벽 대화(밤 ${NIGHT_START > 12 ? NIGHT_START - 12 : NIGHT_START}시~새벽 ${NIGHT_END}시)`;

/** 케미 온도: 0~100 정수일 때만 */
function chemistryCard(c: Chemistry): HighlightCard | null {
  if (!c || !Number.isInteger(c.score) || c.score < 0 || c.score > 100) return null;
  const line = typeof c.line === "string" ? c.line.trim() : "";
  return { key: "chemistry", emoji: "🌡️", label: "케미 온도", value: `${c.score}°`, note: line === "" ? undefined : line };
}

/** 먼저 말 거는 쪽(1:1: 두 사람 비율, 단톡: 대화 시작 1위와 전체 중 몫) */
function initiationsCard(s: ChatStats, pair: boolean): HighlightCard | null {
  const rows = ranked(s.initiations);
  const total = rows.reduce((n, [, v]) => n + v, 0);
  if (total < HIGHLIGHT_RULES.minInitiations) return null;
  const [[top, n]] = rows;
  if (pair && rows.length === 2) {
    const first = Math.round((n / total) * 100);
    return { key: "initiations", emoji: "🙋", label: "먼저 말 거는 쪽", value: `${top} ${first}% vs ${rows[1][0]} ${100 - first}%` };
  }
  return { key: "initiations", emoji: "🙋", label: "대화 시작 1위", value: `${top} · 전체의 ${formatPercent(n / total)}` };
}

function laughCard(s: ChatStats): HighlightCard | null {
  const top = ranked(s.laughChars)[0];
  if (!top || top[1] < HIGHLIGHT_RULES.minLaughChars) return null;
  return { key: "laugh", emoji: "🤣", label: "ㅋ 폭격기 1위", value: `${top[0]} · ㅋ ${formatCount(top[1])}개` };
}

function nightCard(s: ChatStats): HighlightCard | null {
  if (!(s.nightRatio >= HIGHLIGHT_RULES.minNightRatio)) return null;
  return { key: "night", emoji: "🌙", label: nightLabel, value: formatPercent(s.nightRatio) };
}

/** 답장 속도(중앙값): 1:1은 두 사람 다, 단톡은 제일 빠른 사람 */
function replyCard(s: ChatStats, pair: boolean): HighlightCard | null {
  // 빠른 순(동률은 이름 순)
  const rows = ranked(s.replyMedianMs, (name) => (s.byPerson[name] ?? 0) >= HIGHLIGHT_RULES.minReplyMessages).sort(
    ([a, x], [b, y]) => x - y || byName(a, b),
  );
  if (rows.length < 2) return null;
  if (pair && rows.length === 2) {
    return { key: "reply", emoji: "⚡", label: "답장 속도(중앙값)", value: rows.map(([name, ms]) => `${name} ${formatDuration(ms)}`).join(" · ") };
  }
  const [name, ms] = rows[0];
  return { key: "reply", emoji: "⚡", label: "답장 제일 빠른 사람", value: `${name} · 중앙값 ${formatDuration(ms)}` };
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

function questionCard(s: ChatStats): HighlightCard | null {
  const top = ranked(s.questionRate, (name, v) => v > 0 && (s.byPerson[name] ?? 0) >= HIGHLIGHT_RULES.minQuestionMessages)[0];
  if (!top) return null;
  return { key: "question", emoji: "❓", label: "물음표 1위", value: `${top[0]} · 글 메시지의 ${formatPercent(top[1])}` };
}

function photoCard(s: ChatStats): HighlightCard | null {
  const photos = Object.fromEntries(Object.entries(s.media ?? {}).map(([name, m]) => [name, m.photo]));
  const top = ranked(photos)[0];
  if (!top || top[1] < HIGHLIGHT_RULES.minPhotos) return null;
  return { key: "photo", emoji: "📸", label: "사진 담당", value: `${top[0]} · ${formatCount(top[1])}장` };
}

/** 하이라이트 카드(많아야 HIGHLIGHT_RULES.maxCards장). 1:1은 stats에 사람이 둘인 대화다 */
export function highlightCards(stats: ChatStats, opts: { chemistry?: Chemistry } = {}): HighlightCard[] {
  const pair = Object.keys(stats.byPerson).length === 2;
  const cards = [
    chemistryCard(opts.chemistry),
    initiationsCard(stats, pair),
    laughCard(stats),
    nightCard(stats),
    replyCard(stats, pair),
    streakCard(stats),
    dailyCard(stats),
    questionCard(stats),
    photoCard(stats),
  ];
  return cards.filter((c): c is HighlightCard => c !== null).slice(0, HIGHLIGHT_RULES.maxCards);
}
