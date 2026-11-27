// 따옴표 대사·근거 인용을 원문과 대 보는 규칙(v2.5, 2026-11-27 실측 3: 원문과 조금만 달라도 문단이 지워졌다).
// 비교 전에 양쪽을 같은 규칙으로 정규화한다: 공백·줄바꿈, 문장부호(말줄임·!·? 포함)·물결·이모티콘 기호를 지우고,
// ㅋ·ㅎ·ㅠ·ㅜ 같은 자모 반복은 한 글자로 줄이고, 대소문자를 무시한다.
// 맞는 말: 정규화본이 메시지 하나의 부분 문자열이거나, 연속한 두세 메시지를 이어 붙인 것의 부분 문자열이거나,
//   같은 길이 구간과의 글자 겹침이 OVERLAP_MIN 이상이다(matchesSpeech).
// 대화 원문은 여기서도 메모리에서만 다룬다.

/** 지우는 글자: 공백, 문장부호, 기호(물결·하트·이모지 피부색 포함), 그림 문자, 이음·꾸밈 글자 */
const DROPPED = /[\s\p{P}\p{S}\p{Extended_Pictographic}‍︎️]/u;
/** 반복을 한 글자로 줄이는 글자: 한글 호환 자모(ㅋ·ㅎ·ㅠ·ㅜ·ㅇ·ㄷ…) */
const JAMO = /[ㄱ-ㆎ]/u;
/** 글자 겹침이 이 비율 이상이면 같은 말로 본다 */
export const OVERLAP_MIN = 0.8;

/** 정규화한 글과, 정규화한 글자마다 원문에서 시작·끝 위치(UTF-16 위치, 끝은 그 글자 다음) */
function normalizeWithMap(text: string): { norm: string; start: number[]; end: number[] } {
  let norm = "";
  const start: number[] = [];
  const end: number[] = [];
  let i = 0;
  for (const ch of text) {
    const at = i;
    i += ch.length;
    if (DROPPED.test(ch)) continue;
    const lower = ch.toLowerCase();
    // 자모 반복은 앞 글자에 붙인다(원문 구간은 반복 끝까지 늘린다)
    if (JAMO.test(lower) && norm.endsWith(lower)) {
      end[end.length - 1] = i;
      continue;
    }
    for (const c of lower) {
      norm += c;
      start.push(at);
      end.push(i);
    }
  }
  return { norm, start, end };
}

export const normalizeQuote = (text: string) => normalizeWithMap(text).norm;

/** 정규화한 quote(nq)가 든 원문 구간. 처음 나오는 곳이다. 없거나 nq가 비었으면 null */
export function originalSpan(text: string, nq: string): string | null {
  if (nq === "") return null;
  const m = normalizeWithMap(text);
  const at = m.norm.indexOf(nq);
  if (at < 0) return null;
  // 정규화본의 글자 수(코드 유닛)와 위치 배열의 칸 수는 같다(글자를 하나씩 넣었다)
  return text.slice(m.start[at], m.end[at + nq.length - 1]);
}

/**
 * quote 글자 중 메시지에 있는 비율(중복은 개수만큼). 메시지가 quote보다 길면 quote 길이의 구간을 밀며 가장 많이 겹치는 곳을 본다.
 * 메시지가 짧으면 모자란 글자는 겹치지 않은 것으로 센다(한 메시지로 여러 메시지를 지어 합친 말은 낮다)
 */
export function overlapRatio(nq: string, nm: string): number {
  const q = Array.from(nq);
  const m = Array.from(nm);
  if (q.length === 0) return 1;
  if (m.length === 0) return 0;
  const want = new Map<string, number>();
  for (const c of q) want.set(c, (want.get(c) ?? 0) + 1);
  const have = new Map<string, number>();
  let shared = 0;
  const add = (c: string) => {
    const n = have.get(c) ?? 0;
    if (n < (want.get(c) ?? 0)) shared++;
    have.set(c, n + 1);
  };
  const remove = (c: string) => {
    const n = have.get(c)! - 1;
    have.set(c, n);
    if (n < (want.get(c) ?? 0)) shared--;
  };
  const width = Math.min(q.length, m.length);
  for (let k = 0; k < width; k++) add(m[k]);
  let best = shared;
  for (let k = width; k < m.length && best < q.length; k++) {
    add(m[k]);
    remove(m[k - width]);
    best = Math.max(best, shared);
  }
  return best / q.length;
}

/**
 * 정규화한 quote가 한 사람이 보낸 메시지들(정규화본, 보낸 순서)에 맞는 말인가.
 * 메시지 하나 → 연속한 두세 메시지 이어 붙인 것 → 글자 겹침 순서로 본다. 빈 quote(문장부호·이모티콘뿐)는 맞는 것으로 본다
 */
export function matchesSpeech(nq: string, sent: readonly string[]): boolean {
  if (nq === "") return true;
  if (sent.some((m) => m.includes(nq))) return true;
  for (let k = 0; k + 1 < sent.length; k++) {
    const two = sent[k] + sent[k + 1];
    if (two.includes(nq)) return true;
    if (k + 2 < sent.length && (two + sent[k + 2]).includes(nq)) return true;
  }
  return sent.some((m) => overlapRatio(nq, m) >= OVERLAP_MIN);
}
