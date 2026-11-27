// 대화 통계. ChatMessage(이름 정리를 거친 것)만 받는 순수 함수라 브라우저·node 어디서나 돈다.
import { LONG_MESSAGE_CHARS, NIGHT_END, NIGHT_START, SHORT_MESSAGE_CHARS, SILENCE_GAP_MS, TOP_WORDS } from "@/lib/config";
import type { ChatMessage } from "@/lib/parse/parse";
import { findCrossedPatterns } from "./crossed";
import { hiddenWordFilter, topOf, wordsOf } from "./words";

export interface MonthStats {
  count: Record<string, number>;
  replyMedianMs: Record<string, number | null>;
  replyP75Ms: Record<string, number | null>;
  /** 텍스트 메시지가 없는 달은 null(사진만 보낸 달을 0으로 세지 않는다) */
  questionRate: Record<string, number | null>;
  avgLen: Record<string, number | null>;
}

/** replySpeed = 1 / replyMedianMs (클수록 빠르다) */
export type MonthlyMetric = "replySpeed" | "questionRate" | "avgLen" | "count";

/** upPct는 양수, downPct는 음수인 전월 대비 변화율(%) */
export interface CrossedPattern {
  month: string;
  person: string;
  up: MonthlyMetric;
  down: MonthlyMetric;
  upPct: number;
  downPct: number;
}

export interface MessageStyle {
  texts: number;
  chars: number;
  long: number;
  short: number;
}

/** 버릇: 감탄(!)·질문(?)·물결(~)·말줄임(… ..)·이모지·자음 축약(ㅇㅇ·ㄱㄱ, ㅋ·ㅎ만인 것은 빼고)·영어 단어(두 글자 이상)·링크 */
export const HABIT_KEYS = ["exclaim", "question", "tilde", "ellipsis", "emoji", "jamo", "english", "link"] as const;
export type Habits = Record<(typeof HABIT_KEYS)[number], number>;

export interface Unanswered {
  /** 다음 메시지가 있는(대화 맨 끝이 아닌) 차례 수 */
  turns: number;
  /** 그중 6시간 안에 다른 사람이 답하지 않은 차례 수 */
  ignored: number;
  /** 차례 끝에서 다른 사람의 다음 메시지까지 가장 오래 기다린 시간. 그런 메시지가 없으면 null */
  maxWaitMs: number | null;
  /** 연달아 답을 못 받은 차례의 최대 수(그 사람의 차례 순서로) */
  maxStreak: number;
}

export interface ChatStats {
  total: number;
  byPerson: Record<string, number>;
  share: Record<string, number>;
  /** 직전 메시지와 6시간 이상 공백 뒤 첫 메시지(대화 맨 처음 메시지는 제외) */
  initiations: Record<string, number>;
  /** 6시간 이상 공백 직전의 마지막 메시지(대화 맨 끝 메시지는 제외) */
  closings: Record<string, number>;
  /** 그 사람 메시지 뒤 6시간 안에 다른 사람이 답한 비율 */
  replyReceivedRate: Record<string, number>;
  replyMedianMs: Record<string, number | null>;
  replyP75Ms: Record<string, number | null>;
  /** 키 "YYYY-MM" (KST) */
  monthly: Record<string, MonthStats>;
  /** 길이 24, KST 시각별 메시지 수 */
  hourHistogram: number[];
  /** 길이 7, 일요일=0 */
  weekdayHistogram: number[];
  nightRatio: number;
  /** 키 "YYYY-MM-DD" (KST) */
  dailyCounts: Record<string, number>;
  longestStreakDays: number;
  busiestDay: { date: string; count: number } | null;
  /** ㅋ·ㅎ 연속 길이 히스토그램. 인덱스 = 길이(1~10), 10은 "10 이상". 길이 11, 인덱스 0은 항상 0 */
  laughLength: Record<string, number[]>;
  /**
   * v2.8: 글 메시지의 ㅋ 글자 수(길이 상한 없음, ㅎ는 세지 않는다). 글을 보낸 사람마다 있다(0 포함).
   * 화면의 하이라이트 카드('ㅋ 폭격기')만 쓴다. 모델에게 보여 주는 통계(statsForPrompt)에는 넣지 않는다.
   * v2.8 전에 만든 대화(DB·이 브라우저의 예전 페이로드)에는 없다
   */
  laughChars?: Record<string, number>;
  // ── v2.9 화면 전용(통계 카드·읽씹 리포트·대화 버릇·자주 쓰는 단어). 모델에게 보여 주는 통계(statsForPrompt)에는 넣지 않는다.
  //    v2.9 전에 만든 대화에는 없다(화면은 없으면 그 카드를 뺀다)
  /** 사람마다 밤(NIGHT_START~NIGHT_END 전) 메시지 수(사진 포함) */
  nightByPerson?: Record<string, number>;
  /** 방 전체 답장 간격(발신자가 바뀌고 6시간 안)의 중앙값. 답장이 없으면 null */
  replyMedianAll?: number | null;
  /** 글 메시지 모양: 수·글자 수(코드 포인트)·LONG_MESSAGE_CHARS자 이상·SHORT_MESSAGE_CHARS자 이하 */
  style?: Record<string, MessageStyle>;
  /** 버릇이 든 글 메시지 수 */
  habits?: Record<string, Habits>;
  /** 읽씹 리포트: 차례(6시간 안에 이어 보낸 같은 사람의 메시지들)마다 6시간 안에 다른 사람이 답했는지. 대화 맨 끝 차례는 세지 않는다 */
  unanswered?: Record<string, Unanswered>;
  /** 자주 쓰는 단어 TOP_WORDS개(두 번 이상, [단어, 수], 많은 순). lib/stats/words */
  topWords?: Record<string, [string, number][]>;
  /** 텍스트 메시지 중 물음표가 든 비율 */
  questionRate: Record<string, number>;
  media: Record<string, { photo: number; emoticon: number; link: number }>;
  addressTerms: Record<string, Record<string, number>>;
  crossed: CrossedPattern[];
}

const KST_OFFSET_MS = 9 * 3_600_000;
const DAY_MS = 86_400_000;
const LAUGH_MAX = 10;

const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const LAUGH_RE = /[ㅋㅎ]+/g;
const KEK_RE = /ㅋ/g;
// v2.9 버릇. 링크를 지운 글에서 본다(링크 속 점·영어를 버릇으로 세지 않게)
const HABIT_RE: Record<Exclude<(typeof HABIT_KEYS)[number], "jamo" | "link">, RegExp> = {
  exclaim: /[!！]/,
  question: /[?？]/,
  tilde: /[~～]/,
  ellipsis: /…|\.{2,}/,
  emoji: /\p{Extended_Pictographic}/u,
  english: /[A-Za-z]{2,}/,
};
/** 자음만으로 된 두 글자 이상 덩어리(앞뒤가 한글·자모가 아닌 것) */
const JAMO_RE = /(?<![ㄱ-ㅣ가-힣])[ㄱ-ㅎ]{2,}(?![ㄱ-ㅣ가-힣])/g;
const LAUGH_ONLY = /^[ㅋㅎ]+$/;
const QUESTION_RE = /[?？]/;

// 호칭 사전. 앞뒤가 한글이면 다른 단어의 일부라서 세지 않는다(조사는 허용).
const ADDRESS_TERMS = ["자기야", "자기", "여보", "오빠", "언니", "형", "누나", "애기", "아가", "형님", "오라버니"];
const PARTICLES = "이랑|한테|에게|이|은|는|가|도|을|를|아|야|랑|의|께|들|만|보다|처럼";
// 한 구간은 한 번만 센다: 긴 호칭을 앞에 둔 단일 alternation (자기야가 자기로 또 잡히지 않게)
const ADDRESS_ALT = [...ADDRESS_TERMS].sort((x, y) => y.length - x.length).join("|");
const ADDRESS_RE = new RegExp(
  `(?<![가-힣])(${ADDRESS_ALT})(?:(?![가-힣])|(?=(?:${PARTICLES})(?![가-힣])))`,
  "g",
);

const pad = (n: number) => String(n).padStart(2, "0");

/** 정렬된 값의 선형 보간 백분위수. 값이 없으면 null */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function summarize(intervals: number[]): { median: number | null; p75: number | null } {
  const sorted = [...intervals].sort((a, b) => a - b);
  return { median: percentile(sorted, 0.5), p75: percentile(sorted, 0.75) };
}

function bump(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

function ratio(num: number, den: number): number {
  return den === 0 ? 0 : num / den;
}

/**
 * 시스템 메시지(발신자 없음 포함)를 뺀 통계를 계산하고 마지막에 엇갈린 패턴을 붙인다.
 * hiddenNames(v2.9): 분석에서 뺀 멤버·봇·알 수 없음의 원래 이름. 다른 사람이 본문에 써도 자주 쓰는 단어에서 거른다(lib/stats/words).
 * 이 목록은 거르는 데만 쓰고 결과(stats)에는 싣지 않는다
 */
export function computeStats(messages: ChatMessage[], opts: { hiddenNames?: readonly string[] } = {}): ChatStats {
  const msgs = messages
    .filter((m): m is ChatMessage & { sender: string } => m.sender !== null && m.kind !== "system")
    .sort((a, b) => a.ts - b.ts || a.id - b.id);
  const hidden = hiddenWordFilter(opts.hiddenNames ?? [], [...new Set(msgs.map((m) => m.sender))]) ?? undefined;

  const byPerson: Record<string, number> = {};
  const initiations: Record<string, number> = {};
  const closings: Record<string, number> = {};
  const hourHistogram = new Array<number>(24).fill(0);
  const weekdayHistogram = new Array<number>(7).fill(0);
  const dailyCounts: Record<string, number> = {};
  const laughLength: Record<string, number[]> = {};
  const laughChars: Record<string, number> = {};
  const nightByPerson: Record<string, number> = {};
  const style: Record<string, MessageStyle> = {};
  const habits: Record<string, Habits> = {};
  const words: Record<string, Map<string, number>> = {};
  const allIntervals: number[] = [];
  const media: ChatStats["media"] = {};
  const addressTerms: ChatStats["addressTerms"] = {};
  const textCount: Record<string, number> = {};
  const questionCount: Record<string, number> = {};
  const received: Record<string, number> = {};
  const intervals: Record<string, number[]> = {};

  interface MonthAcc {
    count: Record<string, number>;
    intervals: Record<string, number[]>;
    textCount: Record<string, number>;
    questionCount: Record<string, number>;
    lenSum: Record<string, number>;
  }
  const months: Record<string, MonthAcc> = {};
  let night = 0;

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const prev = i > 0 ? msgs[i - 1] : null;
    const next = i + 1 < msgs.length ? msgs[i + 1] : null;
    const who = m.sender;

    const kst = new Date(m.ts + KST_OFFSET_MS);
    const hour = kst.getUTCHours();
    const day = `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())}`;
    const monthKey = day.slice(0, 7);
    const acc = (months[monthKey] ??= { count: {}, intervals: {}, textCount: {}, questionCount: {}, lenSum: {} });

    bump(byPerson, who);
    bump(acc.count, who);
    bump(dailyCounts, day);
    hourHistogram[hour]++;
    weekdayHistogram[kst.getUTCDay()]++;
    const isNight = hour >= NIGHT_START || hour < NIGHT_END;
    if (isNight) night++;
    bump(nightByPerson, who, isNight ? 1 : 0);

    const gapBefore = prev ? m.ts - prev.ts : null;
    if (gapBefore !== null && gapBefore >= SILENCE_GAP_MS) bump(initiations, who);
    if (next && next.ts - m.ts >= SILENCE_GAP_MS) bump(closings, who);

    // 답장 간격: 발신자가 바뀌는 지점에서, 6시간 안일 때만
    if (prev && prev.sender !== who && gapBefore !== null && gapBefore < SILENCE_GAP_MS) {
      (intervals[who] ??= []).push(gapBefore);
      (acc.intervals[who] ??= []).push(gapBefore);
      allIntervals.push(gapBefore);
    }

    // 답장 받음: 이 메시지 뒤 처음 나오는 다른 사람의 메시지가 6시간 안에 있는가
    let j = i + 1;
    while (j < msgs.length && msgs[j].sender === who) j++;
    if (j < msgs.length && msgs[j].ts - m.ts < SILENCE_GAP_MS) bump(received, who);

    const md = (media[who] ??= { photo: 0, emoticon: 0, link: 0 });
    if (m.kind === "photo") md.photo++;
    else if (m.kind === "emoticon") md.emoticon++;

    if (m.kind === "text") {
      // 링크는 마스킹 전 원문에서 센다
      md.link += m.text.match(URL_RE)?.length ?? 0;
      bump(textCount, who);
      bump(acc.textCount, who);
      bump(acc.lenSum, who, [...m.text].length);
      if (QUESTION_RE.test(m.text)) {
        bump(questionCount, who);
        bump(acc.questionCount, who);
      }
      const hist = (laughLength[who] ??= new Array<number>(LAUGH_MAX + 1).fill(0));
      for (const run of m.text.match(LAUGH_RE) ?? []) hist[Math.min(run.length, LAUGH_MAX)]++;
      bump(laughChars, who, m.text.match(KEK_RE)?.length ?? 0);
      // v2.9 글 모양·버릇·단어
      const len = [...m.text].length;
      const st = (style[who] ??= { texts: 0, chars: 0, long: 0, short: 0 });
      st.texts++;
      st.chars += len;
      if (len >= LONG_MESSAGE_CHARS) st.long++;
      if (len <= SHORT_MESSAGE_CHARS) st.short++;
      const hb = (habits[who] ??= { exclaim: 0, question: 0, tilde: 0, ellipsis: 0, emoji: 0, jamo: 0, english: 0, link: 0 });
      const plain = m.text.replace(URL_RE, " ");
      for (const key of Object.keys(HABIT_RE) as (keyof typeof HABIT_RE)[]) if (HABIT_RE[key].test(plain)) hb[key]++;
      if ((plain.match(JAMO_RE) ?? []).some((t) => !LAUGH_ONLY.test(t))) hb.jamo++;
      if (plain !== m.text) hb.link++;
      const counts = (words[who] ??= new Map());
      for (const w of wordsOf(m.text, hidden)) counts.set(w, (counts.get(w) ?? 0) + 1);
      const body = m.text.replace(URL_RE, " ");
      for (const hit of body.matchAll(ADDRESS_RE)) bump((addressTerms[who] ??= {}), hit[1], 1);
    }
  }

  const replyMedianMs: Record<string, number | null> = {};
  const replyP75Ms: Record<string, number | null> = {};
  const share: Record<string, number> = {};
  const replyReceivedRate: Record<string, number> = {};
  const questionRate: Record<string, number> = {};
  for (const who of Object.keys(byPerson)) {
    const s = summarize(intervals[who] ?? []);
    replyMedianMs[who] = s.median;
    replyP75Ms[who] = s.p75;
    share[who] = byPerson[who] / msgs.length;
    replyReceivedRate[who] = ratio(received[who] ?? 0, byPerson[who]);
    questionRate[who] = ratio(questionCount[who] ?? 0, textCount[who] ?? 0);
    initiations[who] ??= 0;
    closings[who] ??= 0;
  }

  const monthly: Record<string, MonthStats> = {};
  for (const key of Object.keys(months).sort()) {
    const a = months[key];
    const ms: MonthStats = { count: a.count, replyMedianMs: {}, replyP75Ms: {}, questionRate: {}, avgLen: {} };
    for (const who of Object.keys(a.count)) {
      const s = summarize(a.intervals[who] ?? []);
      ms.replyMedianMs[who] = s.median;
      ms.replyP75Ms[who] = s.p75;
      const texts = a.textCount[who] ?? 0;
      ms.questionRate[who] = texts > 0 ? ratio(a.questionCount[who] ?? 0, texts) : null;
      ms.avgLen[who] = texts > 0 ? ratio(a.lenSum[who] ?? 0, texts) : null;
    }
    monthly[key] = ms;
  }
  // 엇갈린 패턴의 표본: 달·사람별 답장 간격 수, 대화 기간(첫·마지막 메시지 날짜)이 그달에서 덮은 날짜 수
  const replyCounts: Record<string, Record<string, number>> = {};
  for (const [key, a] of Object.entries(months)) {
    replyCounts[key] = Object.fromEntries(Object.entries(a.intervals).map(([who, xs]) => [who, xs.length]));
  }
  const coveredDays: Record<string, number> = {};
  if (msgs.length > 0) {
    const dayNum = (ts: number) => Math.floor((ts + KST_OFFSET_MS) / DAY_MS);
    const first = dayNum(msgs[0].ts);
    const last = dayNum(msgs[msgs.length - 1].ts);
    for (const key of Object.keys(months)) {
      const [y, mo] = key.split("-").map(Number);
      const start = Date.UTC(y, mo - 1, 1) / DAY_MS;
      const end = Date.UTC(y, mo, 1) / DAY_MS - 1;
      coveredDays[key] = Math.min(end, last) - Math.max(start, first) + 1;
    }
  }

  // 연속 일수: 메시지가 있는 날짜를 일 번호로 바꿔 이어지는 최장 구간을 센다
  const dayNums = Object.keys(dailyCounts)
    .map((d) => Date.parse(`${d}T00:00:00Z`) / DAY_MS)
    .sort((a, b) => a - b);
  let longestStreakDays = 0;
  let run = 0;
  dayNums.forEach((n, i) => {
    run = i > 0 && n - dayNums[i - 1] === 1 ? run + 1 : 1;
    longestStreakDays = Math.max(longestStreakDays, run);
  });

  // v2.9 읽씹: 차례를 나누고, 차례 끝마다 다음 메시지(답했는지)와 다른 사람의 다음 메시지(기다린 시간)를 본다
  const unanswered: Record<string, Unanswered> = Object.fromEntries(
    Object.keys(byPerson).map((who) => [who, { turns: 0, ignored: 0, maxWaitMs: null, maxStreak: 0 }]),
  );
  // nextOther[i]: i 뒤에 처음 나오는 다른 사람의 메시지 번호(없으면 -1)
  const nextOther = new Array<number>(msgs.length).fill(-1);
  for (let i = msgs.length - 2; i >= 0; i--) nextOther[i] = msgs[i + 1].sender !== msgs[i].sender ? i + 1 : nextOther[i + 1];
  const streak: Record<string, number> = {};
  for (let i = 0; i < msgs.length; ) {
    const who = msgs[i].sender;
    let end = i;
    while (end + 1 < msgs.length && msgs[end + 1].sender === who && msgs[end + 1].ts - msgs[end].ts < SILENCE_GAP_MS) end++;
    const next = msgs[end + 1];
    if (next) {
      const u = unanswered[who];
      u.turns++;
      const answered = next.sender !== who && next.ts - msgs[end].ts < SILENCE_GAP_MS;
      if (answered) streak[who] = 0;
      else {
        u.ignored++;
        streak[who] = (streak[who] ?? 0) + 1;
        u.maxStreak = Math.max(u.maxStreak, streak[who]);
      }
      const other = nextOther[end];
      if (other >= 0) u.maxWaitMs = Math.max(u.maxWaitMs ?? 0, msgs[other].ts - msgs[end].ts);
    }
    i = end + 1;
  }

  let busiestDay: ChatStats["busiestDay"] = null;
  for (const [date, count] of Object.entries(dailyCounts).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (busiestDay === null || count > busiestDay.count) busiestDay = { date, count };
  }

  return {
    total: msgs.length,
    byPerson,
    share,
    initiations,
    closings,
    replyReceivedRate,
    replyMedianMs,
    replyP75Ms,
    monthly,
    hourHistogram,
    weekdayHistogram,
    nightRatio: ratio(night, msgs.length),
    dailyCounts,
    longestStreakDays,
    busiestDay,
    laughLength,
    laughChars,
    nightByPerson,
    replyMedianAll: summarize(allIntervals).median,
    style,
    habits,
    unanswered,
    topWords: Object.fromEntries(Object.entries(words).map(([who, counts]) => [who, topOf(counts, TOP_WORDS)])),
    questionRate,
    media,
    addressTerms,
    crossed: findCrossedPatterns(monthly, { replies: replyCounts, coveredDays }),
  };
}
