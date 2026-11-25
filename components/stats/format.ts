// 통계 화면의 포맷과 모양 잡기. DOM 없이 테스트한다.
import type { ChatStats, CrossedPattern, MonthlyMetric } from "@/lib/stats/compute";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const KST_OFFSET_MS = 9 * HOUR;
const pad = (n: number) => String(n).padStart(2, "0");

/** 답장 간격 같은 시간. 1분 미만 / N분 / N시간 M분 / N일 M시간(반올림한 단위가 차면 윗단위로 올린다) */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "-";
  if (ms < MINUTE) return "1분 미만";
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) return `${minutes}분`;
  if (minutes < 24 * 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m === 0 ? `${h}시간` : `${h}시간 ${m}분`;
  }
  const hours = Math.round(ms / HOUR);
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  return h === 0 ? `${d}일` : `${d}일 ${h}시간`;
}

export const formatPercent = (ratio: number) => `${Math.round(ratio * 100)}%`;
export const formatCount = (n: number) => n.toLocaleString("ko-KR");

/** epoch ms → KST 날짜 YYYY-MM-DD */
export function kstDate(ts: number): string {
  const d = new Date(ts + KST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 대화 기간: dailyCounts의 첫날·마지막 날(KST, YYYY-MM-DD)과 그 사이 날수(양 끝 포함). 메시지가 없으면 null */
export function periodOf(dailyCounts: Record<string, number>): { from: string; to: string; days: number } | null {
  const dates = Object.keys(dailyCounts).sort();
  if (dates.length === 0) return null;
  const from = dates[0];
  const to = dates[dates.length - 1];
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (24 * HOUR)) + 1;
  return { from, to, days };
}

/** 메시지 많은 순서(동률은 이름 순) 상위 n명과 나머지 사람 수 */
export function topPeople(stats: Pick<ChatStats, "byPerson">, n: number): { people: string[]; rest: number } {
  const all = Object.entries(stats.byPerson)
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
    .map(([name]) => name);
  return { people: all.slice(0, n), rest: Math.max(0, all.length - n) };
}

/** 달력 히트맵 한 줄: 그 달의 1~31일. 없는 날(2월 30일 등)은 null */
export interface HeatRow {
  month: string;
  days: (number | null)[];
}

/** dailyCounts의 첫 달부터 마지막 달까지 빠짐없이 */
export function heatmapRows(dailyCounts: Record<string, number>): HeatRow[] {
  const dates = Object.keys(dailyCounts).sort();
  if (dates.length === 0) return [];
  const [y0, m0] = dates[0].split("-").map(Number);
  const [y1, m1] = dates[dates.length - 1].split("-").map(Number);
  const rows: HeatRow[] = [];
  for (let n = y0 * 12 + (m0 - 1); n <= y1 * 12 + (m1 - 1); n++) {
    const y = Math.floor(n / 12);
    const m = (n % 12) + 1;
    const month = `${y}-${pad(m)}`;
    const length = new Date(Date.UTC(y, m, 0)).getUTCDate();
    rows.push({ month, days: Array.from({ length: 31 }, (_, i) => (i < length ? (dailyCounts[`${month}-${pad(i + 1)}`] ?? 0) : null)) });
  }
  return rows;
}

/** 0은 0단계, 나머지는 최댓값 대비 1~4단계 */
export function heatLevel(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || max <= 0) return 0;
  return Math.max(1, Math.min(4, Math.ceil((count / max) * 4))) as 1 | 2 | 3 | 4;
}

const UP: Record<MonthlyMetric, string> = {
  replySpeed: "답장이 {p} 빨라졌는데",
  questionRate: "질문이 {p} 늘었는데",
  avgLen: "메시지가 {p} 길어졌는데",
  count: "메시지 수가 {p} 늘었는데",
};
const DOWN: Record<MonthlyMetric, string> = {
  replySpeed: "답장은 {p} 느려졌어요",
  questionRate: "질문은 {p} 줄었어요",
  avgLen: "메시지는 {p} 짧아졌어요",
  count: "메시지 수는 {p} 줄었어요",
};

/** 엇갈린 패턴을 묘사만 한다(해석은 "어떻게 느꼈나요?"로 본인에게 넘긴다) */
export function crossedText(c: CrossedPattern): string {
  const pct = (n: number) => `${Math.round(Math.abs(n))}%`;
  return `${UP[c.up].replace("{p}", pct(c.upPct))} ${DOWN[c.down].replace("{p}", pct(c.downPct))}`;
}
