// 숫자 부록(v2.9): 읽씹 리포트·대화 버릇·자주 쓰는 단어. 코드가 통계로 만든다(AI 비용 없음). 리포트 끝(마무리 뒤)의 표·목록이 쓴다.
// 사람은 메시지 많은 순(동률은 이름 순)으로 DETAIL_RULES.maxPeople명까지. 예전 통계(필드 없음)는 빈 목록이라 화면이 그 카드를 뺀다
import { formatDuration, formatPercent, topPeople } from "@/components/stats/format";
import { type ChatStats, HABIT_KEYS } from "./compute";

export const DETAIL_RULES = {
  /** 읽씹 리포트·자주 쓰는 단어에 보이는 사람 수 */
  maxPeople: 6,
  /** 대화 버릇 표의 칸(사람) 수. 375px 화면에서 칸이 좁아지지 않게 */
  habitPeople: 4,
  /** 대화 버릇을 비율로 낼 글 메시지 수 하한 */
  minHabitTexts: 10,
  /** 읽씹 리포트에 넣을 차례 수 하한 */
  minTurns: 5,
} as const;

export const HABIT_LABEL: Record<(typeof HABIT_KEYS)[number], string> = {
  exclaim: "느낌표 !",
  question: "물음표 ?",
  tilde: "물결 ~",
  ellipsis: "말줄임 …",
  emoji: "이모지",
  jamo: "자음 축약 ㅇㅇ",
  english: "영어",
  link: "링크",
};

const ranked = (stats: ChatStats) => topPeople(stats, Object.keys(stats.byPerson).length).people;

export interface UnansweredRow {
  name: string;
  turns: number;
  ignored: number;
  rate: string;
  /** 가장 오래 기다린 시간("2일 3시간"). 없으면 "-" */
  maxWait: string;
  maxStreak: number;
}

/** 읽씹 리포트: 차례가 DETAIL_RULES.minTurns번 이상인 사람 */
export function unansweredRows(stats: ChatStats): UnansweredRow[] {
  const u = stats.unanswered ?? {};
  return ranked(stats)
    .filter((name) => (u[name]?.turns ?? 0) >= DETAIL_RULES.minTurns)
    .slice(0, DETAIL_RULES.maxPeople)
    .map((name) => {
      const r = u[name];
      return { name, turns: r.turns, ignored: r.ignored, rate: formatPercent(r.ignored / r.turns), maxWait: formatDuration(r.maxWaitMs), maxStreak: r.maxStreak };
    });
}

/** 대화 버릇 표: 칸은 사람(글 메시지 DETAIL_RULES.minHabitTexts개 이상), 줄은 버릇(글 메시지 대비 %). top은 그 줄 1위 칸 번호. 아무도 안 쓴 버릇은 뺀다 */
export function habitTable(stats: ChatStats): { people: string[]; rows: { key: string; label: string; values: string[]; top: number }[] } {
  const h = stats.habits ?? {};
  const texts = (name: string) => stats.style?.[name]?.texts ?? 0;
  const people = ranked(stats)
    .filter((name) => h[name] && texts(name) >= DETAIL_RULES.minHabitTexts)
    .slice(0, DETAIL_RULES.habitPeople);
  const rows = HABIT_KEYS.flatMap((key) => {
    const ratios = people.map((name) => h[name][key] / texts(name));
    const best = Math.max(...ratios, 0);
    if (best <= 0) return [];
    return [{ key, label: HABIT_LABEL[key], values: ratios.map(formatPercent), top: ratios.indexOf(best) }];
  });
  return { people: rows.length === 0 ? [] : people, rows };
}

/** 자주 쓰는 단어: 단어가 있는 사람 */
export function wordRows(stats: ChatStats): { name: string; words: [string, number][] }[] {
  const w = stats.topWords ?? {};
  return ranked(stats)
    .filter((name) => (w[name]?.length ?? 0) > 0)
    .slice(0, DETAIL_RULES.maxPeople)
    .map((name) => ({ name, words: w[name] }));
}
