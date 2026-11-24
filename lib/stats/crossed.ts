// 전월 대비 한 지표는 크게 오르고 다른 지표는 크게 내린 달(엇갈린 패턴)을 찾는다.
// 표본이 작으면 몇 개 차이로도 ±100%가 나오므로 하한을 둔다: 두 달 모두 그 사람 메시지 20개 이상, 답장 속도는 답장 간격 5개 이상.
// 대화가 그달 며칠만 덮는 달(내보낸 달의 앞뒤)은 비교하지 않고, 메시지 수는 덮은 날짜로 나눈 하루 평균으로 비교한다.
import type { ChatStats, CrossedPattern, MonthlyMetric, MonthStats } from "./compute";

const THRESHOLD_PCT = 20;
const MIN_MONTH_MESSAGES = 20;
const MIN_MONTH_REPLIES = 5;
const MIN_COVERED_DAYS = 14;

/** 표본 정보. replies: 달 → 사람 → 답장 간격 수, coveredDays: 달 → 대화 기간이 덮은 날짜 수 */
export interface CrossedSample {
  replies?: Record<string, Record<string, number>>;
  coveredDays?: Record<string, number>;
}

/** 방향을 맞춘 지표 값. replySpeed는 답장 간격의 역수라 클수록 빠르다. count는 덮은 날짜가 있으면 하루 평균. 값을 알 수 없으면 null */
function metricValue(m: MonthStats, person: string, metric: MonthlyMetric, days: number | undefined): number | null {
  switch (metric) {
    case "replySpeed": {
      const ms = m.replyMedianMs[person];
      return ms == null || ms <= 0 ? null : 1 / ms;
    }
    case "questionRate":
      return m.questionRate[person] ?? null;
    case "avgLen":
      return m.avgLen[person] ?? null;
    case "count": {
      const n = m.count[person];
      return n == null ? null : days ? n / days : n;
    }
  }
}

const METRICS: MonthlyMetric[] = ["replySpeed", "questionRate", "avgLen", "count"];

function prevMonth(key: string): string {
  const [y, mo] = key.split("-").map(Number);
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`;
}

/**
 * 사람·달마다 가장 크게 오른 지표와 가장 크게 내린 지표를 짝지어 돌려준다. 전월이 없거나 0·null이면 그 지표는 건너뛴다.
 * 표본 하한(메시지·답장 간격·덮은 날짜)에 못 미치면 그 사람-달이나 지표를 건너뛴다. sample을 안 주면 메시지 하한만 본다
 */
export function findCrossedPatterns(monthly: ChatStats["monthly"], sample: CrossedSample = {}): CrossedPattern[] {
  const out: CrossedPattern[] = [];
  const covered = (key: string) => sample.coveredDays?.[key];
  const replies = (key: string, person: string) => sample.replies?.[key]?.[person] ?? 0;
  for (const month of Object.keys(monthly).sort()) {
    const prevKey = prevMonth(month);
    const prev = monthly[prevKey];
    if (!prev) continue;
    if ((covered(prevKey) ?? MIN_COVERED_DAYS) < MIN_COVERED_DAYS || (covered(month) ?? MIN_COVERED_DAYS) < MIN_COVERED_DAYS) continue;
    const cur = monthly[month];
    for (const person of Object.keys(cur.count)) {
      if ((prev.count[person] ?? 0) < MIN_MONTH_MESSAGES || cur.count[person] < MIN_MONTH_MESSAGES) continue;
      let up: { metric: MonthlyMetric; pct: number } | null = null;
      let down: { metric: MonthlyMetric; pct: number } | null = null;
      for (const metric of METRICS) {
        if (
          metric === "replySpeed" &&
          sample.replies &&
          (replies(prevKey, person) < MIN_MONTH_REPLIES || replies(month, person) < MIN_MONTH_REPLIES)
        ) {
          continue;
        }
        const before = metricValue(prev, person, metric, covered(prevKey));
        const after = metricValue(cur, person, metric, covered(month));
        if (before === null || before === 0 || after === null) continue;
        const pct = ((after - before) / before) * 100;
        if (pct >= THRESHOLD_PCT && (!up || pct > up.pct)) up = { metric, pct };
        if (pct <= -THRESHOLD_PCT && (!down || pct < down.pct)) down = { metric, pct };
      }
      if (up && down) out.push({ month, person, up: up.metric, down: down.metric, upPct: up.pct, downPct: down.pct });
    }
  }
  return out;
}
