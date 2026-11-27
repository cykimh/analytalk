// 따옴표 대사·근거 인용을 원문과 대 보는 규칙(v2.5, 2026-11-27 실측 3: 원문과 조금만 달라도 문단이 지워졌다).
// 비교 전에 양쪽을 같은 규칙으로 정규화한다: 공백·줄바꿈, 문장부호(말줄임·!·? 포함)·물결·이모티콘 기호를 지우고,
// ㅋ·ㅎ·ㅠ·ㅜ 같은 자모 반복은 한 글자로 줄이고, 대소문자를 무시한다.
// 따옴표 대사(matchesSpeech): 정규화본이 메시지 하나나 연속한 두세 메시지를 이어 붙인 것의 부분 문자열이거나,
//   메시지 하나의 한 구간과 편집 거리 비율이 SPEECH_SIMILARITY_MIN 이상이고 뜻을 뒤집는 글자를 더하지 않았으면 맞는 말이다.
//   리뷰 I1: 글자 묶음 겹침은 순서를 안 봐서 "진짜 안 좋아"·"철수가 민지를 좋아해" 같은 지어낸 대사가 남았다.
// 근거 카드(overlapRatio): 글자 겹침 OVERLAP_MIN 이상이면 그 메시지 전체를 넣는다(카드는 원문 글자로 바꿔 넣으니 순서를 안 봐도 된다).
// 비용(리뷰 minor 3): 부분 문자열은 보낸 사람마다 한 번 이어 붙인 글에서 찾고, 편집 거리는 quote 글자 수 표로 거른 메시지에만 계산한다.
// 대화 원문은 여기서도 메모리에서만 다룬다.

/** 지우는 글자: 공백, 문장부호, 기호(물결·하트·이모지 피부색 포함), 그림 문자, 이음·꾸밈 글자 */
const DROPPED = /[\s\p{P}\p{S}\p{Extended_Pictographic}‍︎️]/u;
/** 반복을 한 글자로 줄이는 글자: 한글 호환 자모(ㅋ·ㅎ·ㅠ·ㅜ·ㅇ·ㄷ…) */
const JAMO = /[ㄱ-ㆎ]/u;
/** 근거 카드: 글자 겹침이 이 비율 이상이면 그 메시지로 본다 */
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
    // 정규화본 한 칸(UTF-16)마다 원문 위치를 둔다: 두 칸 글자(CJK 확장 B·수학 글꼴)도 칸 수가 맞게(리뷰 minor 5)
    for (const c of lower) {
      norm += c;
      for (let k = 0; k < c.length; k++) {
        start.push(at);
        end.push(i);
      }
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

/** 따옴표 대사가 메시지의 한 구간과 이만큼 비슷하면(1 − 최소 편집 수 / quote 길이) 같은 말로 본다. 순서를 본다(리뷰 I1) */
export const SPEECH_SIMILARITY_MIN = 0.8;
/**
 * 뜻을 뒤집는 글자: 부정(안·못·않·아니)과 사람(나·내·너·네·니). 비슷한 말이어도 quote가 원문 구간보다 이것을 많이 가졌으면
 * 같은 말로 보지 않는다("진짜 안 좋아" ↔ "진짜 좋아", "오늘은 네가 살게" ↔ "오늘은 내가 살게")
 */
const FLIPS = ["안", "못", "않", "아니", "나", "내", "너", "네", "니"];
const countOf = (text: string, token: string) => {
  let n = 0;
  for (let at = text.indexOf(token); at >= 0; at = text.indexOf(token, at + token.length)) n++;
  return n;
};
const addsFlip = (nq: string, window: string) => FLIPS.some((t) => countOf(nq, t) > countOf(window, t));

/** 한 사람이 보낸 메시지(정규화본, 보낸 순서)와 그것을 이어 붙인 글. 이어 붙인 글에서 메시지 경계를 찾으려고 시작 위치를 둔다 */
export interface SpeechIndex {
  sent: readonly string[];
  joined: string;
  starts: number[];
}
export function speechIndex(sent: readonly string[]): SpeechIndex {
  const starts: number[] = [];
  let at = 0;
  for (const m of sent) {
    starts.push(at);
    at += m.length;
  }
  return { sent, joined: sent.join(""), starts };
}
/** 이어 붙인 글의 pos가 든 메시지 번호(빈 메시지는 건너뛴다) */
function messageAt(starts: number[], pos: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * quote 전체를 메시지의 어느 구간으로 바꾸는 최소 편집 수(앞뒤는 공짜, Sellers). limit보다 큰 줄이 나오면 그만둔다.
 * limit 이하인 끝 위치마다 편집 수와 그 구간을 돌려준다(뜻 뒤집기 검사에 구간이 필요하다)
 */
function alignments(q: string, m: string, limit: number): { d: number; window: string }[] {
  const cols = m.length + 1;
  let dPrev = new Int32Array(cols);
  let sPrev = new Int32Array(cols);
  let dCur = new Int32Array(cols);
  let sCur = new Int32Array(cols);
  for (let j = 0; j < cols; j++) sPrev[j] = j;
  for (let i = 1; i <= q.length; i++) {
    dCur[0] = i;
    sCur[0] = 0;
    let best = dCur[0];
    const qc = q.charCodeAt(i - 1);
    for (let j = 1; j < cols; j++) {
      let d = dPrev[j - 1] + (qc === m.charCodeAt(j - 1) ? 0 : 1);
      let s = sPrev[j - 1];
      if (dPrev[j] + 1 < d) {
        d = dPrev[j] + 1;
        s = sPrev[j];
      }
      if (dCur[j - 1] + 1 < d) {
        d = dCur[j - 1] + 1;
        s = sCur[j - 1];
      }
      dCur[j] = d;
      sCur[j] = s;
      if (d < best) best = d;
    }
    if (best > limit) return [];
    [dPrev, dCur] = [dCur, dPrev];
    [sPrev, sCur] = [sCur, sPrev];
  }
  const out: { d: number; window: string }[] = [];
  for (let j = 0; j < cols; j++) if (dPrev[j] <= limit) out.push({ d: dPrev[j], window: m.slice(sPrev[j], j) });
  return out;
}

/** 1 − 최소 편집 수 / quote 길이(quote를 메시지의 한 구간으로). 테스트·설명용 */
export function speechSimilarity(nq: string, nm: string): number {
  if (nq.length === 0) return 1;
  const all = alignments(nq, nm, nq.length);
  return 1 - Math.min(nq.length, ...all.map((a) => a.d)) / nq.length;
}

// quote 글자 수 표(따옴표마다 한 번 만들고 지운다)와 메시지 글자 수 표. UTF-16 칸 번호로 센다
const WANT = new Int32Array(65_536);
const HAVE = new Int32Array(65_536);

/** 정규화한 quote가 sources(보낸 사람마다 SpeechIndex, 또는 한 사람의 정규화한 메시지 목록) 어딘가의 같은 말인가 */
function fuzzyMatch(nq: string, sources: readonly SpeechIndex[]): boolean {
  const limit = Math.floor(nq.length * (1 - SPEECH_SIMILARITY_MIN) + 1e-9);
  if (limit === 0) return false;
  const need = nq.length - limit;
  for (let k = 0; k < nq.length; k++) WANT[nq.charCodeAt(k)]++;
  try {
    for (const source of sources) {
      for (const m of source.sent) {
        // 메시지가 quote의 0.8배보다 짧으면 편집 수가 이미 한도를 넘는다
        if (m.length < need) continue;
        // 맞춘 글자가 need개 이상이어야 하므로 글자 수 표로 먼저 거른다
        let shared = 0;
        for (let k = 0; k < m.length; k++) {
          const c = m.charCodeAt(k);
          if (HAVE[c]++ < WANT[c]) shared++;
        }
        for (let k = 0; k < m.length; k++) HAVE[m.charCodeAt(k)] = 0;
        if (shared < need) continue;
        if (alignments(nq, m, limit).some((a) => !addsFlip(nq, a.window))) return true;
      }
    }
    return false;
  } finally {
    for (let k = 0; k < nq.length; k++) WANT[nq.charCodeAt(k)] = 0;
  }
}

/**
 * 정규화한 quote가 보낸 메시지의 말인가(sources: 보낸 사람마다 SpeechIndex, 또는 한 사람의 정규화한 메시지 목록).
 * 메시지 하나나 연속한 두세 메시지를 이어 붙인 것의 부분 문자열이면 맞다. 아니면 메시지 하나의 구간과 편집 거리 비율
 * SPEECH_SIMILARITY_MIN 이상이고 뜻을 뒤집는 글자(FLIPS)를 더하지 않았으면 맞다. 빈 quote(문장부호·이모티콘뿐)는 맞는 것으로 본다
 */
export function matchesSpeech(nq: string, sources: readonly string[] | readonly SpeechIndex[]): boolean {
  if (nq === "") return true;
  const indexes: readonly SpeechIndex[] =
    sources.length > 0 && typeof sources[0] === "string" ? [speechIndex(sources as readonly string[])] : (sources as readonly SpeechIndex[]);
  for (const { joined, starts } of indexes) {
    for (let at = joined.indexOf(nq); at >= 0; at = joined.indexOf(nq, at + 1)) {
      if (messageAt(starts, at + nq.length - 1) - messageAt(starts, at) <= 2) return true;
    }
  }
  return fuzzyMatch(nq, indexes);
}
