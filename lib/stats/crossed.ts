// 전월 대비 한 지표는 크게 오르고 다른 지표는 크게 내린 달(엇갈린 패턴)을 찾는다.
import type { ChatStats, CrossedPattern, MonthlyMetric, MonthStats } from "./compute";

const THRESHOLD_PCT = 20;

/** 방향을 맞춘 지표 값. replySpeed는 답장 간격의 역수라 클수록 빠르다. 값을 알 수 없으면 null */
function metricValue(m: MonthStats, person: string, metric: MonthlyMetric): number | null {
  switch (metric) {
    case "replySpeed": {
      const ms = m.replyMedianMs[person];
      return ms == null || ms <= 0 ? null : 1 / ms;
    }
    case "questionRate":
      return m.questionRate[person] ?? null;
    case "avgLen":
      return m.avgLen[person] ?? null;
    case "count":
      return m.count[person] ?? null;
  }
}

const METRICS: MonthlyMetric[] = ["replySpeed", "questionRate", "avgLen", "count"];

function prevMonth(key: string): string {
  const [y, mo] = key.split("-").map(Number);
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`;
}

/** 사람·달마다 가장 크게 오른 지표와 가장 크게 내린 지표를 짝지어 돌려준다. 전월이 없거나 0·null이면 그 지표는 건너뛴다 */
export function findCrossedPatterns(monthly: ChatStats["monthly"]): CrossedPattern[] {
  const out: CrossedPattern[] = [];
  for (const month of Object.keys(monthly).sort()) {
    const prev = monthly[prevMonth(month)];
    if (!prev) continue;
    const cur = monthly[month];
    for (const person of Object.keys(cur.count)) {
      let up: { metric: MonthlyMetric; pct: number } | null = null;
      let down: { metric: MonthlyMetric; pct: number } | null = null;
      for (const metric of METRICS) {
        const before = metricValue(prev, person, metric);
        const after = metricValue(cur, person, metric);
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
