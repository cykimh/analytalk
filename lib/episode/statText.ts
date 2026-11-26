// 모델이 쓴 글(headline·dek·섹션 제목·문단·예고·reading_notes)의 {{stat:경로}} 자리표시자를 통계 값으로 채운다(브라우저·서버 공용).
// 값은 validateReport와 같은 resolveStat으로 풀어서, 저장 전 검증이 남긴 문단은 화면에서도 같은 값으로 보인다.
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
  // avgLen(평균 글자 수)처럼 소수인 값은 한 자리까지
  count: (n) => formatCount(Math.round(n * 10) / 10),
};

/**
 * 화면이 붙인 단위를 모델이 자리표시자 바로 뒤에 한 번 더 쓴 것("{{stat:share.x}}%" → "67%%").
 * 띄어 쓰지 않고 붙은 것만 지운다. 셀 단위가 없는 count("{{stat:total}}개")는 건드리지 않는다
 */
const REPEATED_UNIT: Record<StatUnit, RegExp | null> = {
  ms: /^(?:밀리초|ms|시간|분|초)/,
  ratio: /^(?:%|퍼센트|프로)/,
  days: /^일/,
  count: null,
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
    // 앞 자리표시자 뒤에서 단위를 지우느라 at이 이 자리표시자를 넘었으면 그만큼만 건너뛴다
    pushText(text.slice(at, Math.max(at, m.index)));
    at = Math.max(at, m.index + m[0].length);
    const inner = m[1];
    if (!inner.startsWith(STAT_PREFIX)) continue;
    const path = inner.slice(STAT_PREFIX.length);
    const stat = resolveStat(path, stats);
    if (!stat) continue;
    out.push({ path, display: FORMAT[stat.unit](stat.value) });
    const repeated = REPEATED_UNIT[stat.unit]?.exec(text.slice(at));
    if (repeated) at += repeated[0].length;
  }
  pushText(text.slice(at));
  return out;
}

/** 숫자 바로 뒤에 띄어 쓰지 않고 붙은 말(조사·문장부호)을 숫자와 묶는 길이 상한 */
export const MAX_STAT_TAIL = 6;

/** 화면에 그릴 조각: 글자, 또는 통계 값 + 바로 뒤에 붙은 짧은 말(tail, 없으면 "") */
export type StatChunk = string | (StatToken & { tail: string });

/**
 * 통계 값과 바로 뒤에 붙은 짧은 말("23%로,", "6번의")을 한 조각으로 묶는다. 화면은 이 조각을 줄바꿈 없이 그린다.
 * "%"와 한글 사이는 keep-all이어도 줄이 바뀔 수 있어, 묶지 않으면 "…비율은 23%" / "로, 궁금한…"처럼 조사가 줄 맨 앞에 온다.
 * 띄어 쓰지 않은 긴 말(MAX_STAT_TAIL 초과)까지 묶으면 375px에서 넘칠 수 있어 그때는 묶지 않는다
 */
export function glueTails(parts: (string | StatToken)[]): StatChunk[] {
  const out: StatChunk[] = [];
  for (let i = 0; i < parts.length; i++) {
    const t = parts[i];
    if (typeof t === "string") {
      out.push(t);
      continue;
    }
    const next = parts[i + 1];
    const tail = typeof next === "string" ? (/^\S+/.exec(next)?.[0] ?? "") : "";
    if (tail === "" || tail.length > MAX_STAT_TAIL) {
      out.push({ ...t, tail: "" });
      continue;
    }
    out.push({ ...t, tail });
    const rest = (next as string).slice(tail.length);
    if (rest !== "") out.push(rest);
    i++;
  }
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
