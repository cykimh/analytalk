// 모델이 쓴 글(headline·dek·섹션 제목·문단·예고·reading_notes)의 {{stat:경로}} 자리표시자를 통계 값으로 채운다(브라우저·서버 공용).
// 값은 validateEpisode와 같은 resolveStat으로 풀어서, 저장 전 검증이 남긴 문단은 화면에서도 같은 값으로 보인다.
// 화면은 조각을 React 텍스트 노드로만 그린다(components/episode/StatText). <title>·OG처럼 문자열이 필요하면 renderStatPlain.
import { formatCount, formatDuration, formatPercent } from "@/components/stats/format";
import type { ChatStats } from "@/lib/stats/compute";
import { resolveStat, type StatUnit } from "@/lib/stats/paths";

/** {{…}} 자리표시자(validate.ts와 같은 모양) */
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const STAT_PREFIX = "stat:";

export type StatToken = { path: string; display: string };

const FORMAT: Record<StatUnit, (value: number) => string> = {
  ms: formatDuration,
  ratio: formatPercent,
  days: (n) => `${formatCount(n)}일`,
  count: formatCount,
};

/**
 * 글 조각과 채운 통계 조각. 풀리지 않는 자리표시자(모르는 경로·값 없음·stat이 아닌 것)는 빼고,
 * 그 양옆 글자는 한 조각으로 잇는다. 빈 글자 조각은 넣지 않는다
 */
export function renderStatText(text: string, stats: ChatStats): (string | StatToken)[] {
  const out: (string | StatToken)[] = [];
  const pushText = (s: string) => {
    if (s === "") return;
    const last = out.length - 1;
    if (typeof out[last] === "string") out[last] += s;
    else out.push(s);
  };
  let at = 0;
  for (const m of text.matchAll(PLACEHOLDER)) {
    pushText(text.slice(at, m.index));
    at = m.index + m[0].length;
    const inner = m[1];
    if (!inner.startsWith(STAT_PREFIX)) continue;
    const path = inner.slice(STAT_PREFIX.length);
    const stat = resolveStat(path, stats);
    if (stat) out.push({ path, display: FORMAT[stat.unit](stat.value) });
  }
  pushText(text.slice(at));
  return out;
}

/** 채운 글을 문자열 하나로(<title>·OG·공유 카드처럼 조각을 그릴 수 없는 곳) */
export function renderStatPlain(text: string, stats: ChatStats): string {
  return renderStatText(text, stats)
    .map((t) => (typeof t === "string" ? t : t.display))
    .join("");
}

/** 채운 뒤 보일 글자가 남는다. 아니면 화면은 기본 제목을 쓰거나 그 줄을 그리지 않는다 */
export const hasStatText = (text: string | null, stats: ChatStats): text is string =>
  text !== null && renderStatPlain(text, stats).trim() !== "";
