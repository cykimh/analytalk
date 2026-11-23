// 리포트 본문의 {{stat:경로}} 자리표시자가 가리킬 수 있는 통계 경로와 그 값 조회.
import type { ChatStats, MonthStats } from "./compute";

export type StatUnit = "ms" | "count" | "ratio" | "days";

/** 모델에게 알려 주는 허용 경로. <이름>·<YYYY-MM>은 실제 값으로 바꿔 쓴다 */
export const STAT_PATHS: string[] = [
  "total",
  "byPerson.<이름>",
  "share.<이름>",
  "initiations.<이름>",
  "closings.<이름>",
  "replyReceivedRate.<이름>",
  "replyMedianMs.<이름>",
  "replyP75Ms.<이름>",
  "questionRate.<이름>",
  "nightRatio",
  "longestStreakDays",
  "busiestDay.count",
  "media.<이름>.photo",
  "media.<이름>.emoticon",
  "media.<이름>.link",
  "monthly.<YYYY-MM>.count.<이름>",
  "monthly.<YYYY-MM>.replyMedianMs.<이름>",
  "monthly.<YYYY-MM>.replyP75Ms.<이름>",
  "monthly.<YYYY-MM>.questionRate.<이름>",
  "monthly.<YYYY-MM>.avgLen.<이름>",
];

const PERSON_UNITS: Record<string, StatUnit> = {
  byPerson: "count",
  share: "ratio",
  initiations: "count",
  closings: "count",
  replyReceivedRate: "ratio",
  replyMedianMs: "ms",
  replyP75Ms: "ms",
  questionRate: "ratio",
};

const MONTH_UNITS: Record<string, StatUnit> = {
  count: "count",
  replyMedianMs: "ms",
  replyP75Ms: "ms",
  questionRate: "ratio",
  avgLen: "count",
};

const MEDIA_KEYS = ["photo", "emoticon", "link"] as const;

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function lookup(rec: Record<string, number | null> | undefined, name: string): number | null {
  return rec && own(rec, name) ? num(rec[name]) : null;
}

/** 경로를 숫자와 단위로 푼다. 허용 목록에 없거나 값이 없으면 null. 이름에 점이 있어도 이름은 경로 끝까지로 본다 */
export function resolveStat(path: string, stats: ChatStats): { value: number; unit: StatUnit } | null {
  const seg = path.split(".");
  const head = seg[0];
  const done = (value: number | null, unit: StatUnit) => (value === null ? null : { value, unit });

  if (seg.length === 1) {
    if (head === "total") return done(stats.total, "count");
    if (head === "nightRatio") return done(stats.nightRatio, "ratio");
    if (head === "longestStreakDays") return done(stats.longestStreakDays, "days");
    return null;
  }
  if (head === "busiestDay" && seg.length === 2 && seg[1] === "count") {
    return done(stats.busiestDay?.count ?? null, "count");
  }
  if (own(PERSON_UNITS, head)) {
    const rec = stats[head as keyof typeof PERSON_UNITS & keyof ChatStats] as Record<string, number | null>;
    return done(lookup(rec, seg.slice(1).join(".")), PERSON_UNITS[head]);
  }
  if (head === "media" && seg.length >= 3) {
    const key = seg[seg.length - 1];
    if (!(MEDIA_KEYS as readonly string[]).includes(key)) return null;
    const entry = own(stats.media, seg.slice(1, -1).join("."))
      ? stats.media[seg.slice(1, -1).join(".")]
      : undefined;
    return done(entry ? entry[key as (typeof MEDIA_KEYS)[number]] : null, "count");
  }
  if (head === "monthly" && seg.length >= 4) {
    const month = own(stats.monthly, seg[1]) ? stats.monthly[seg[1]] : undefined;
    const metric = seg[2];
    if (!month || !own(MONTH_UNITS, metric)) return null;
    const rec = month[metric as keyof MonthStats] as Record<string, number | null>;
    return done(lookup(rec, seg.slice(3).join(".")), MONTH_UNITS[metric]);
  }
  return null;
}
