// 저장 전 검증(PRD 5장, v2 설계 G7). 서버 전용. 검증을 거치지 않은 문장은 저장하지도 보여 주지도 않는다.
// safety: 구조 검사보다 먼저 원본에서 본다. flag가 none이 아닌 문자열이면 다른 필드가 틀려도 도움 안내로 간다.
// 근거: msg_id가 보낸 줄에 있고 quote가 그 본문의 부분 문자열이어야(원문 일치) 남는다. 어느 문단도 쓰지 않는 근거는 버리고,
//   남은 것을 리포트 전체 MAX_QUOTES_PER_REPORT개까지 앞 섹션부터 센다(고아 근거가 뒤 구성의 몫을 먹지 않게).
//   마지막 구성(마무리) 섹션이 쓰는 근거 몫은 CLOSING_QUOTE_RESERVE개까지 따로 남겨 둔다(앞 섹션이 몫을 다 써도 마무리가 인용을 단다).
// 문단: 풀리지 않는 자리표시자, 금지 표현·개인정보가 든 문단, 너무 긴 문단을 지운다. 남은 문단 키는 섹션마다 p1, p2…
// 구성 키(part)는 그 말투의 구성(TONES[tone].parts)만 남긴다.
// v2.4: 근거의 msg_id가 틀려도(긴 입력에서 m번호를 잘못 옮긴 경우) quote가 든 메시지가 있으면 가장 가까운 번호의 그 메시지로
//   다시 잇는다(relink). 보낸 사람·시각은 이은 메시지의 것이라 카드가 거짓이 되지 않는다. 짧은 quote(정규화해 RELINK_SHORT_CHARS자 미만)는
//   흔한 말("ㅋㅋ")이 엉뚱한 곳에 붙지 않게 가까운 번호(RELINK_NEAR) 안에서만 찾는다. 사람 섹션이면 그 사람이 보낸 메시지를 먼저 본다.
// v2.4: 지운 까닭을 센다(checks.dropped_by). 대화 원문·이름 없는 숫자뿐이라 저장한다(운영에서 문단이 왜 줄었는지 확인용).
// v2.4 Fix 1·v2.5: 금지 표현은 banned.ts의 넷(혐오·차별, 자해·폭력 부추김, 성적 묘사, 성적 지향 단정)과 글자로 쓴 %뿐이다.
// v2.5(2026-11-27 실측 3: 섹션 5·문단 10만 남아 partial. inline_quote 7, ungrounded 3, evidence_orphan 8):
//   - 문단 안 인용(따옴표 대사)은 quoteMatch의 정규화로 원문과 대 본다(띄어쓰기·문장부호·ㅋ 개수·두세 메시지 합침·글자 겹침 80%).
//     그래도 안 맞으면 문단을 지우지 않고 그 따옴표 문자만 떼어 서술로 남긴다(checks.unquoted). 제목·headline·dek도 같다.
//     인용으로 보는 것: "…"·“…”·＂…＂·‘…’·「…」·『…』·〈…〉·《…》 전부, 그리고 말을 옮기는 말(라고·라는·란·라 했다·고 했다·하고·했다·며 등)이
//     바로 뒤에 붙거나 캐치프레이즈·말버릇 같은 말이 바로 앞에 있는 '…'(Fix 3). 인용이 든 문장에 멤버 이름이 나오면 그 멤버의 메시지와,
//     없으면 아무 멤버의 메시지와 대 본다(민지의 말을 철수의 말로 옮긴 따옴표도 떼어진다).
//   - 근거 없는 사람 문단(ungrounded)과 근거 id를 모두 잃은 문단(fake_evidence)도 지우지 않는다(근거 id만 빠진다).
//   - 근거 카드는 실제 메시지처럼 말풍선으로 보이므로 원문 확인은 그대로 하되, 정규화로 맞으면 그 메시지의 원문 글자로 바꿔 넣는다
//     (checks.requoted). m번호의 메시지와 정규화로 안 맞으면 relink(글자 그대로 → 정규화 순)로 찾고, 그래도 없으면 m번호 메시지와
//     글자 겹침 80% 이상일 때 그 메시지 전체를 넣는다. 그래도 못 찾는 카드만 뺀다.
// 나머지 모델 글(headline·dek·제목)도 같은 검사(금지 표현·개인정보·글자 수)에 걸리면 비운다. icon·about·part는 허용 모양만 남긴다.
// 자리표시자 경로 속 범례 기호(A, B…)는 표시 이름으로 바꾼다(모델이 줄의 기호를 그대로 옮겨 쓴 경우).
import "server-only";
import { MAX_QUOTES_PER_REPORT, PARTIAL_DROP_RATIO } from "@/lib/config";
import { isBanned } from "@/lib/payload/banned";
import { memberCodes, type payloadIndex } from "@/lib/payload/build";
import { hasPII } from "@/lib/payload/mask";
import type { ChatStats } from "@/lib/stats/compute";
import { resolveStat } from "@/lib/stats/paths";
import { type Tone, TONES } from "./concepts";
import { sanitizeNotes } from "./notes";
import { matchesSpeech, normalizeQuote, OVERLAP_MIN, originalSpan, overlapRatio, type SpeechIndex, speechIndex } from "./quoteMatch";
import { DECLINED_TOPICS, type DropReason, type Report, reportSchema, type StoredReport, type ValidationChecks } from "./schema";

type Index = ReturnType<typeof payloadIndex>;
type IndexLine = Index extends Map<string, infer L> ? L : never;
type StoredSection = StoredReport["sections"][number];
type Paragraph = Report["sections"][number]["paragraphs"][number];

export interface ValidateResult {
  status: "done" | "partial" | "safety" | "failed";
  content: StoredReport | null;
  /** 지운 문단·근거 수. checks는 지운 까닭별 수와 다시 이은 근거 수(failed·safety면 빈 값) */
  dropped: { paragraphs: number; evidence: number; checks: ValidationChecks };
}

/** 다시 잇기(relink): 짧은 quote는 이 번호 거리 안에서만 찾는다 */
export const RELINK_NEAR = 30;
/** 이 글자 수보다 짧은 quote는 가까운 번호에서만 다시 잇는다 */
export const RELINK_SHORT_CHARS = 6;

/** 페이로드 본문의 줄바꿈 표시(build.ts의 render) */
const LINE_BREAK_MARK = " ⏎ ";
/** {{…}} 자리표시자. 허용하는 것은 {{stat:경로}}뿐이다 */
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const STAT = "stat:";

/** 잘린 응답에서 빠졌을 수 있는 뒤쪽 필드의 기본값. safety는 기본값이 없다(없으면 failed) */
const TRUNCATED_DEFAULTS = { declined_topics: [], reading_notes: [], headline: "", dek: "", sections: [] };

/** 모델 글의 글자 수 상한(코드 포인트). 넘으면 자르지 않고 비운다(자르면 자리표시자가 반쪽이 될 수 있다). system 프롬프트도 알린다 */
/**
 * v2.2: 문단이 3~4문장(120~200자)으로 길어져 문단 상한을 800 → 1000자로 올렸다.
 * v2.3: 문단 지시가 4~7문장 250~400자로 길어져 1000 → 1200자(지시 위쪽 끝 400자의 세 배 여유)
 */
export const MAX_CHARS = { headline: 80, dek: 200, title: 60, paragraph: 1200, icon: 8 } as const;
const length = (text: string) => Array.from(text).length;

/** 마지막 구성(마무리) 섹션 몫으로 따로 남겨 두는 근거 수. 그 섹션이 쓰는 만큼만(많아야 이만큼) 남긴다 */
export const CLOSING_QUOTE_RESERVE = 2;
/**
 * 글 안의 인용(Fix 2·3). 한국어 독자에게는 어느 따옴표든 그 멤버의 말로 읽히므로 따옴표 모양마다 원문과 대 본다.
 * 곧은·둥근·전각 큰따옴표, 둥근 작은따옴표, 낫표·겹낫표, 꺾쇠·겹꺾쇠는 늘 인용이다(system 프롬프트는 큰따옴표 밖의 것을 쓰지 말라고 한다)
 */
const BRACKET_QUOTE = /"([^"]+)"|“([^”]+)”|＂([^＂]+)＂|‘([^’]+)’|「([^」]+)」|『([^』]+)』|〈([^〉]+)〉|《([^》]+)》/g;
/** 곧은 작은따옴표 '…'. 별명·상 이름·사건명·자막에도 쓰므로 앞뒤 글을 보고 인용인지 정한다(QUOTATIVE·SPEECH_BEFORE·NAMING) */
const SINGLE_QUOTE = /'([^'\n]+)'/g;
/**
 * '…' 바로 뒤(한 칸 띄어도)에 붙으면 말을 옮긴 것으로 보는 말(Fix 3).
 * 라고·라며·라는·라던·라니·라 했다·란·래, 다고·냐고·자고, 고 했다, 하고·하며·했다·한다, 며·면서.
 * '라서'·'라면'·'이고'·'이며'(이다의 활용, 별명 뒤에 흔하다)는 넣지 않는다
 */
const QUOTATIVE = new RegExp(
  `^\\s?(?:${[
    "이?라(?:고|며|면서|는|던|니|더|길래|기에)",
    "이?라(?=\\s|$|[.,!?…])",
    "이?란",
    // '첫 만남' 이래로(그 뒤로)는 뺀다
    "이?래(?!로)",
    "이?랬",
    "(?:다|냐|자)(?:고|며|면서|는)",
    "고(?![가-힣])",
    "하고",
    "하며",
    "하면서",
    "했",
    "한다",
    "하더",
    "하던",
    "하는\\s*말",
    "며",
    "면서",
  ].join("|")})`,
);
/**
 * QUOTATIVE에 걸려도 인용이 아닌 것: 부르는 이름('선톡왕'이라고 불린다·'…'라 부른다), 이름 붙이기('…'라고 이름 붙였다),
 * 이름을 가리키는 '…'라는·'…'란 + 별명·이름·상·사건 같은 말. 부·불로 시작하는 다른 동사(부탁·불평·부인)는 빼 주지 않는다
 */
const NAMING = new RegExp(
  `^\\s?(?:${[
    "이?라(?:고)?\\s*(?:불리|불린|불릴|불러|불렀|부르|부른|부를|부름)",
    "이?라(?:고)?\\s*(?:이름|별명)(?:을|이)?\\s*(?:붙|지)",
    "이?(?:라는|란)\\s*(?:별명|별칭|이름|칭호|호칭|타이틀|수식어|자막|사건|코너|상(?=[을이은의도과와]|\\s|[.,!?]|$))",
  ].join("|")})`,
);
/** 바로 앞(8자 안)에 이런 말이 있으면 '…'는 그 사람이 한 말이다(캐치프레이즈는 '…'다) */
const SPEECH_BEFORE = /(?:캐치프레이즈|말버릇|입버릇|대사|어록|유행어)[^'\n]{0,8}$/;
/** 문장 경계. 따옴표 구간을 덮은 글에서 찾으므로 인용 속 물음표·마침표는 경계가 아니다 */
const SENTENCE_END = /[.!?。\n]/;
/** 이름 바로 뒤에 붙으면 그 사람은 말한 사람이 아니라 듣는 사람·대상이다(민지에게·철수를) */
const NOT_SPEAKER = /^이?(?:에게|한테|께(?!서)|더러|를|을)/;
const blank = (s: string) => " ".repeat(s.length);

/**
 * 원문과 대 볼 보낸 메시지(정규화본, 보낸 순서). 보낸 사람마다 이어 붙인 글까지 처음 쓸 때 한 번만 만든다(리뷰 minor 3).
 * all은 모든 보낸 사람의 것이다(인용이 든 문장에 이름이 없을 때)
 */
type Corpus = { all: () => SpeechIndex[]; of: (senders: string[]) => SpeechIndex[] };
function corpusOf(idx: Index): Corpus {
  let bySender: Map<string, SpeechIndex> | null = null;
  const build = () => {
    if (bySender === null) {
      const lists = new Map<string, string[]>();
      for (const line of idx.values()) {
        const list = lists.get(line.sender) ?? [];
        list.push(normalizeQuote(toNewlines(line.text)));
        lists.set(line.sender, list);
      }
      bySender = new Map(Array.from(lists, ([name, sent]) => [name, speechIndex(sent)]));
    }
    return bySender;
  };
  return {
    all: () => [...build().values()],
    of: (senders) => senders.flatMap((name) => build().get(name) ?? []),
  };
}

/**
 * 글 안의 인용과 그 자리. masked는 따옴표 구간 전부(인용이 아닌 별명도)와 자리표시자를 같은 길이의 빈칸으로 덮은 글이다:
 * 인용 속 이름·문장부호를 말한 사람·문장 경계로 잘못 보지 않게 한다
 */
function findQuotes(text: string): { quotes: { start: number; end: number; quote: string }[]; masked: string } {
  const quotes: { start: number; end: number; quote: string }[] = [];
  for (const m of text.matchAll(BRACKET_QUOTE)) {
    quotes.push({ start: m.index, end: m.index + m[0].length, quote: m.slice(1).find((g) => g !== undefined) ?? "" });
  }
  // 큰따옴표 속 아포스트로피와 짝이 엇갈리지 않게, 큰따옴표류를 덮은 글에서 작은따옴표를 순서대로 짝짓는다
  const noBrackets = text.replace(BRACKET_QUOTE, blank);
  for (const m of noBrackets.matchAll(SINGLE_QUOTE)) {
    const end = m.index + m[0].length;
    const after = noBrackets.slice(end);
    if (SPEECH_BEFORE.test(noBrackets.slice(0, m.index)) || (QUOTATIVE.test(after) && !NAMING.test(after))) {
      quotes.push({ start: m.index, end, quote: m[1] });
    }
  }
  return { quotes, masked: noBrackets.replace(SINGLE_QUOTE, blank).replace(PLACEHOLDER, blank) };
}

/** 인용이 든 문장(masked 기준)에서 말한 사람으로 볼 수 있는 멤버. 듣는 사람·대상으로만 나온 이름은 뺀다 */
function speakersNear(masked: string, start: number, end: number, members: string[]): string[] {
  let from = start;
  while (from > 0 && !SENTENCE_END.test(masked[from - 1])) from--;
  let to = end;
  while (to < masked.length && !SENTENCE_END.test(masked[to])) to++;
  const sentence = masked.slice(from, to);
  return members.filter((name) => {
    for (let i = sentence.indexOf(name); i >= 0; i = sentence.indexOf(name, i + 1)) {
      if (!NOT_SPEAKER.test(sentence.slice(i + name.length))) return true;
    }
    return false;
  });
}

/**
 * 글 안의 인용(따옴표 대사)을 원문과 대 보고, 맞지 않는 인용은 따옴표 문자만 뗀다(v2.5). 고친 글과 뗀 인용 수를 돌려준다.
 * 인용이 든 문장에 멤버 이름이 나오면 그 멤버(들) 중 누군가의 메시지와, 없으면 아무 멤버의 메시지와 대 본다(Fix 3).
 * 한 문장에 두 사람이 나오면 둘 중 누구의 말이든 맞으면 된다. 길이 하한은 없다(빈 칸만 든 것은 건너뛴다)
 */
function unquoteUnmatched(text: string, corpus: Corpus, members: string[]): { text: string; unquoted: number } {
  const { quotes, masked } = findQuotes(text);
  const wrong = quotes.filter((q) => {
    const quote = toNewlines(q.quote).trim();
    if (quote === "") return false;
    const speakers = speakersNear(masked, q.start, q.end, members);
    const nq = normalizeQuote(quote);
    return !matchesSpeech(nq, speakers.length > 0 ? corpus.of(speakers) : corpus.all());
  });
  if (wrong.length === 0) return { text, unquoted: 0 };
  // 따옴표는 모두 한 글자(UTF-16 한 칸)다. 뒤에서부터 떼어 앞쪽 자리가 밀리지 않게 한다
  let out = text;
  for (const q of [...wrong].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, q.start) + out.slice(q.start + 1, q.end - 1) + out.slice(q.end);
  }
  return { text: out, unquoted: wrong.length };
}

/**
 * 풀리는 {{stat:경로}} 자리표시자를 뺀 글. 경로 속 표시 이름이 링크 끝과 같은 말(Me·Com)이어도 개인정보로 보지 않게 한다.
 * 풀리지 않는 자리표시자는 남겨서 그 속의 개인정보도 검사한다
 */
const withoutStats = (text: string, stats: ChatStats) =>
  text.replace(PLACEHOLDER, (whole, inner: string) =>
    inner.startsWith(STAT) && resolveStat(inner.slice(STAT.length), stats) !== null ? "" : whole,
  );
/** 저장할 수 없는 까닭(글자 수·금지 표현·개인정보, PRD 5장 1·6). 저장해도 되면 null */
function unstorable(text: string, max: number, stats: ChatStats): DropReason | null {
  if (length(text) > max) return "too_long";
  if (isBanned(text)) return "banned";
  if (hasPII(withoutStats(text, stats))) return "pii";
  return null;
}
/** 제목·headline·dek: 원문과 안 맞는 인용은 따옴표를 떼고(v2.5), 그래도 저장할 수 없으면 비운다 */
function clean(text: string, max: number, stats: ChatStats, corpus: Corpus, members: string[], checks: ValidationChecks): string {
  const fixed = unquoteUnmatched(text, corpus, members);
  if (unstorable(fixed.text, max, stats) !== null) return "";
  checks.unquoted += fixed.unquoted;
  return fixed.text;
}
/** 이모지 몇 글자만. 글자·숫자가 들었으면(문장을 넣었으면) 비운다 */
const cleanIcon = (icon: string) => {
  const t = icon.trim();
  return length(t) <= MAX_CHARS.icon && !/[\p{L}\p{N}]/u.test(t) ? t : "";
};
const ABOUT_FIXED = new Set(["pair", "group"]);
const toNewlines = (text: string) => text.replaceAll(LINE_BREAK_MARK, "\n");

/**
 * {{stat:경로}}의 점(.)으로 나뉜 조각 중 범례 기호와 같은 것을 그 표시 이름으로 바꾼다.
 * memberCodes는 표시 이름과 같은 기호를 건너뛰므로 이름을 기호로 잘못 보는 일은 없다. 경로 밖 본문은 고치지 않는다
 */
function codesToNames(members: string[]): (text: string) => string {
  const codes = memberCodes(members);
  const nameOf = new Map(codes.map((code, i) => [code, members[i]]));
  return (text) =>
    text.replace(PLACEHOLDER, (whole, inner: string) =>
      inner.startsWith(STAT)
        ? `{{${STAT}${inner
            .slice(STAT.length)
            .split(".")
            .map((part) => nameOf.get(part) ?? part)
            .join(".")}}}`
        : whole,
    );
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 원본의 safety.flag(대소문자·앞뒤 공백 정리). 문자열이 아니면 null.
 * SDK 스키마 변환이 enum·min/max를 설명으로만 넘겨 API가 강제하지 않으므로, 표에 없는 값("self-harm" 등)도 온다
 */
function rawSafetyFlag(raw: unknown): string | null {
  if (!isRecord(raw) || !isRecord(raw.safety) || typeof raw.safety.flag !== "string") return null;
  return raw.safety.flag.trim().toLowerCase();
}

/**
 * 구조 검사 전 손질. truncated면 빠진 뒤쪽 필드에 기본값을 넣는다. safety는 정리한 "none"으로 맞춘다.
 * declined_topics는 참고용이고 API가 enum을 강제하지 않으므로, 모르는 값은 버린다.
 * part가 없는 섹션(v1 모양 출력)은 part를 ""로 둔다(구성 키는 뒤에서 어차피 정리한다)
 */
function prepare(raw: unknown, truncated: boolean): unknown {
  if (!isRecord(raw)) return raw;
  const obj: Record<string, unknown> = truncated ? { ...TRUNCATED_DEFAULTS, ...raw } : { ...raw };
  if (rawSafetyFlag(raw) === "none") obj.safety = { flag: "none" };
  if (Array.isArray(obj.declined_topics)) {
    obj.declined_topics = obj.declined_topics.filter((t) => (DECLINED_TOPICS as readonly unknown[]).includes(t));
  }
  if (Array.isArray(obj.sections)) {
    obj.sections = obj.sections.map((s) => (isRecord(s) && s.part === undefined ? { ...s, part: "" } : s));
  }
  return obj;
}

/** 자리표시자가 모두 {{stat:경로}}이고 resolveStat으로 풀리면 그 개수, 하나라도 아니면 null */
function placeholderCount(text: string, stats: ChatStats): number | null {
  let n = 0;
  for (const [, inner] of text.matchAll(PLACEHOLDER)) {
    if (!inner.startsWith(STAT) || resolveStat(inner.slice(STAT.length), stats) === null) return null;
    n++;
  }
  return n;
}

/** m번호(m123) → 123. 모양이 다르면 null */
const refNumber = (ref: string) => (/^m\d+$/.test(ref) ? Number(ref.slice(1)) : null);

/**
 * quote가 든 메시지 중 claimed(모델이 적은 m번호)에 가장 가까운 것(v2.4 relink). 글자 그대로 든 메시지가 있으면 그것만,
 * 없으면 정규화본이 든 메시지에서 고른다(v2.5). 없으면 null.
 * prefer(사람 섹션의 그 사람)가 보낸 메시지가 있으면 그중에서만 고른다. 짧은 quote(정규화해 RELINK_SHORT_CHARS자 미만)는 RELINK_NEAR 안에서만
 */
function relink(lines: NumberedLine[], claimed: string, quote: string, nq: string, prefer: string | null) {
  const at = refNumber(claimed);
  const short = length(nq) < RELINK_SHORT_CHARS;
  if (short && at === null) return null;
  const near = lines.filter((x) => !short || Math.abs(x.n - at!) <= RELINK_NEAR);
  const exact = near.filter((x) => toNewlines(x.line.text).includes(quote));
  const found = exact.length > 0 ? exact : near.filter((x) => x.norm().includes(nq));
  const pool = prefer !== null && found.some((x) => x.line.sender === prefer) ? found.filter((x) => x.line.sender === prefer) : found;
  if (pool.length === 0) return null;
  const distance = (n: number) => (at === null ? n : Math.abs(n - at));
  return pool.reduce((best, x) => (distance(x.n) < distance(best.n) ? x : best));
}

/** 번호 붙은 보낸 줄. 정규화본은 처음 볼 때 만든다 */
type NumberedLine = { ref: string; n: number; line: IndexLine; norm: () => string };

/**
 * 구조만 본다(v2.5: 나눠 쓴 호출마다 먼저 보고 합친다). safety가 먼저다: 걸린 응답이 구조 검사에서 failed가 되면 도움 안내 대신
 * [다시 쓰기]가 보이고, 같은 위험 대화가 다시 유료 호출로 간다. truncated면 빠진 뒤쪽 필드에 기본값을 넣는다
 */
export function parseReport(raw: unknown, truncated: boolean): { kind: "safety" } | { kind: "failed" } | { kind: "report"; report: Report } {
  const flag = rawSafetyFlag(raw);
  if (flag !== null && flag !== "none") return { kind: "safety" };
  const parsed = reportSchema.safeParse(prepare(raw, truncated));
  return parsed.success ? { kind: "report", report: parsed.data } : { kind: "failed" };
}

const emptyChecks = (): ValidationChecks => ({ relinked: 0, requoted: 0, unquoted: 0, dropped_by: {} });

export function validateReport(
  raw: unknown,
  idx: Index,
  stats: ChatStats,
  opts: { truncated: boolean; tone: Tone; members: string[] },
): ValidateResult {
  const none = { paragraphs: 0, evidence: 0, checks: emptyChecks() };
  const parsed = parseReport(raw, opts.truncated);
  if (parsed.kind !== "report") return { status: parsed.kind, content: null, dropped: none };
  const { report } = parsed;

  const named = codesToNames(opts.members);
  const parts = new Set<string>(TONES[opts.tone].parts.map((p) => p.key));
  const closingPart = TONES[opts.tone].parts.at(-1)?.key;
  const people = Object.keys(stats.byPerson);
  // 글 안의 인용을 맞춰 볼 보낸 메시지(정규화본). 인용이 있을 때 한 번만 만든다
  const corpus = corpusOf(idx);
  const paragraphsIn = report.sections.reduce((n, s) => n + s.paragraphs.length, 0);
  const evidenceIn = report.sections.reduce((n, s) => n + s.evidence.length, 0);
  const checks = emptyChecks();
  const drop = (reason: DropReason, n = 1) => {
    if (n > 0) checks.dropped_by[reason] = (checks.dropped_by[reason] ?? 0) + n;
  };
  // 다시 잇기에 쓰는 번호 붙은 줄 목록. 틀린 근거가 있을 때 한 번만 만든다
  let numbered: NumberedLine[] | null = null;
  const lines = () =>
    (numbered ??= Array.from(idx, ([ref, line]): NumberedLine => {
      let norm: string | null = null;
      return { ref, n: refNumber(ref) ?? -1, line, norm: () => (norm ??= normalizeQuote(toNewlines(line.text))) };
    }).filter((x) => x.n >= 0));

  /**
   * 근거 하나를 원문에 맞춘다(v2.5). 글자 그대로 → m번호 메시지의 정규화 구간 → relink(글자 그대로·정규화) → m번호 메시지와 글자 겹침 순.
   * 정규화·겹침으로 맞으면 quote를 그 메시지의 원문 글자로 바꾼다. 못 찾으면 null
   */
  const verify = (e: Report["sections"][number]["evidence"][number], prefer: string | null): StoredSection["evidence"][number] | null => {
    const quote = toNewlines(e.quote);
    const line = idx.get(e.msg_id);
    const original = line ? toNewlines(line.text) : null;
    if (line && original!.includes(quote)) return { id: e.id, msg_id: e.msg_id, quote, sender: line.sender, at: line.at };
    const nq = normalizeQuote(quote);
    if (nq === "") return null;
    const span = original === null ? null : originalSpan(original, nq);
    if (line && span !== null) {
      checks.requoted++;
      return { id: e.id, msg_id: e.msg_id, quote: span, sender: line.sender, at: line.at };
    }
    const found = relink(lines(), e.msg_id, quote, nq, prefer);
    if (found) {
      const text = toNewlines(found.line.text);
      const exact = text.includes(quote);
      checks.relinked++;
      if (!exact) checks.requoted++;
      return { id: e.id, msg_id: found.ref, quote: exact ? quote : originalSpan(text, nq)!, sender: found.line.sender, at: found.line.at };
    }
    if (line && overlapRatio(nq, normalizeQuote(original!)) >= OVERLAP_MIN) {
      checks.requoted++;
      return { id: e.id, msg_id: e.msg_id, quote: original!, sender: line.sender, at: line.at };
    }
    return null;
  };

  // 1차: 섹션마다 남을 문단과 그 문단이 쓰는 근거를 정한다. 근거 몫과 상관없이 정해진다
  const judged = report.sections.flatMap((section) => {
    // 1) 근거: 원문과 맞는 것만(verify), 같은 id는 처음 것만
    const aboutPerson = people.includes(section.about);
    const valid: StoredSection["evidence"] = [];
    for (const e of section.evidence) {
      const ok = e.quote.trim() === "" || valid.some((v) => v.id === e.id) ? null : verify(e, aboutPerson ? section.about : null);
      if (ok === null) drop("evidence_unmatched");
      else valid.push(ok);
    }
    const verified = new Set(valid.map((e) => e.id));

    // 2) 문단: 원문과 안 맞는 인용은 따옴표만 떼고(v2.5), 글 검사(빈 글·자리표시자·글자 수·금지 표현·개인정보)에 걸리면 지운다.
    // evidence_ids는 원문과 맞은 것만 남긴다. 근거를 모두 잃었거나 근거가 없는 사람 문단도 남는다(v2.5)
    const paragraphs = section.paragraphs.flatMap((p): Paragraph[] => {
      const fixed = unquoteUnmatched(named(p.text), corpus, opts.members);
      const text = fixed.text;
      // 지울 까닭을 앞에서부터 하나 고른다(빈 글 → 자리표시자 → 글자 수·금지 표현·개인정보)
      const why: DropReason | null =
        text.trim() === "" ? "empty" : placeholderCount(text, stats) === null ? "placeholder" : unstorable(text, MAX_CHARS.paragraph, stats);
      if (why !== null) {
        drop(why);
        return [];
      }
      checks.unquoted += fixed.unquoted;
      return [{ ...p, text, evidence_ids: p.evidence_ids.filter((id) => verified.has(id)) }];
    });
    // 남는 문단이 쓰는 근거만 몫을 센다(고아 근거는 버린다)
    const used = new Set(paragraphs.flatMap((p) => p.evidence_ids));
    drop("evidence_orphan", valid.filter((e) => !used.has(e.id)).length);
    // 문단이 다 지워진 섹션은 빼고, 그 근거는 몫에서 쓰지 않는다
    if (paragraphs.length === 0) return [];
    return [{ section, aboutPerson, paragraphs, wanted: valid.filter((e) => used.has(e.id)) }];
  });

  // 2차: 근거 몫을 앞 섹션부터 나눈다. 마무리 섹션이 쓰는 근거는 CLOSING_QUOTE_RESERVE개까지 미리 떼어 둔다
  const isClosing = (s: { section: { part: string } }) => s.section.part === closingPart;
  let quotesLeft = MAX_QUOTES_PER_REPORT;
  let reserveLeft = Math.min(
    CLOSING_QUOTE_RESERVE,
    quotesLeft,
    judged.filter(isClosing).reduce((n, s) => n + s.wanted.length, 0),
  );
  let paragraphsOut = 0;
  let evidenceOut = 0;
  const sections: StoredSection[] = judged.map((j) => {
    const closing = isClosing(j);
    const budget = closing ? quotesLeft : quotesLeft - reserveLeft;
    const evidence = j.wanted.slice(0, Math.max(0, budget));
    drop("evidence_over_budget", j.wanted.length - evidence.length);
    const kept = new Set(evidence.map((e) => e.id));
    quotesLeft -= evidence.length;
    if (closing) reserveLeft = Math.max(0, reserveLeft - evidence.length);
    paragraphsOut += j.paragraphs.length;
    evidenceOut += evidence.length;
    return {
      ...j.section,
      part: parts.has(j.section.part) ? j.section.part : "",
      icon: cleanIcon(j.section.icon),
      title: clean(named(j.section.title), MAX_CHARS.title, stats, corpus, opts.members, checks),
      about: ABOUT_FIXED.has(j.section.about) || j.aboutPerson ? j.section.about : "group",
      paragraphs: j.paragraphs.map((p, i) => ({ ...p, key: `p${i + 1}`, evidence_ids: p.evidence_ids.filter((id) => kept.has(id)) })),
      evidence,
    };
  });

  const dropped = { paragraphs: paragraphsIn - paragraphsOut, evidence: evidenceIn - evidenceOut, checks };
  if (sections.length === 0) return { status: "failed", content: null, dropped };
  const content: StoredReport = {
    ...report,
    checks,
    reading_notes: sanitizeNotes(report.reading_notes.map((n) => ({ ...n, note: named(n.note) }))),
    headline: clean(named(report.headline), MAX_CHARS.headline, stats, corpus, opts.members, checks),
    dek: clean(named(report.dek), MAX_CHARS.dek, stats, corpus, opts.members, checks),
    sections,
  };
  const partial = opts.truncated || dropped.paragraphs / paragraphsIn >= PARTIAL_DROP_RATIO;
  return { status: partial ? "partial" : "done", content, dropped };
}
