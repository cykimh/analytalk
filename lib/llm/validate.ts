// 저장 전 검증(PRD 5장, v2 설계 G7). 서버 전용. 검증을 거치지 않은 문장은 저장하지도 보여 주지도 않는다.
// safety: 구조 검사보다 먼저 원본에서 본다. flag가 none이 아닌 문자열이면 다른 필드가 틀려도 도움 안내로 간다.
// 근거: msg_id가 보낸 줄에 있고 quote가 그 본문의 부분 문자열이어야(원문 일치) 남는다. 어느 문단도 쓰지 않는 근거는 버리고,
//   남은 것을 리포트 전체 MAX_QUOTES_PER_REPORT개까지 앞 섹션부터 센다(고아 근거가 뒤 구성의 몫을 먹지 않게).
//   마지막 구성(마무리) 섹션이 쓰는 근거 몫은 CLOSING_QUOTE_RESERVE개까지 따로 남겨 둔다(앞 섹션이 몫을 다 써도 마무리가 인용을 단다).
// 문단: 풀리지 않는 자리표시자, 금지 표현·개인정보가 든 문단, 너무 긴 문단을 지운다. 남은 문단 키는 섹션마다 p1, p2…
// 가짜 인용(v2.2 Fix 1): 근거를 달았는데 그중 원문과 맞는 것이 하나도 없는 문단은 지운다(사람 문단이든 아니든).
//   문단 안 인용은 보낸 메시지 어느 하나의 부분 문자열이어야 한다. 아니면 문단을 지운다(제목·headline·dek는 비운다).
//   인용으로 보는 것(Fix 2): "…"·“…”·‘…’·「…」·『…』 전부, 그리고 말을 옮기는 토씨(라고·이라고·라며·하고·하며·며)가 바로 뒤에 붙은 '…'.
//   토씨 없는 '…'(별명·상 이름·자막)와 '…'이라고 부르는 별명은 인용으로 보지 않는다. 길이 하한은 없다(빈 칸만 든 것만 건너뛴다).
// 사람 근거(v2.2): 근거를 하나도 달지 않은 문단만 섹션 단위로 본다. 사람을 다루는 섹션(about이 참여자이거나 문단에 이름이 나온다)은
//   원문과 맞는 근거를 쓰는 문단이나 풀리는 자리표시자가 섹션 어디든 하나 있으면 된다. 둘 다 없으면 이름이 든 문단(about이 사람이면 전부)을 지운다.
//   몫 때문에 근거 카드가 빠져도 원문과 맞은 근거를 단 문단은 남는다(카드만 빠진다). 문단을 지우는 것은 몫과 상관없이 정해진다.
// 구성 키(part)는 그 말투의 구성(TONES[tone].parts)만 남긴다.
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
import { DECLINED_TOPICS, type Report, reportSchema, type StoredReport } from "./schema";

type Index = ReturnType<typeof payloadIndex>;
type StoredSection = StoredReport["sections"][number];
type Paragraph = Report["sections"][number]["paragraphs"][number];

export interface ValidateResult {
  status: "done" | "partial" | "safety" | "failed";
  content: StoredReport | null;
  dropped: { paragraphs: number; evidence: number };
}

/** 페이로드 본문의 줄바꿈 표시(build.ts의 render) */
const LINE_BREAK_MARK = " ⏎ ";
/** {{…}} 자리표시자. 허용하는 것은 {{stat:경로}}뿐이다 */
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const STAT = "stat:";

/** 잘린 응답에서 빠졌을 수 있는 뒤쪽 필드의 기본값. safety는 기본값이 없다(없으면 failed) */
const TRUNCATED_DEFAULTS = { declined_topics: [], reading_notes: [], headline: "", dek: "", sections: [] };

/** 모델 글의 글자 수 상한(코드 포인트). 넘으면 자르지 않고 비운다(자르면 자리표시자가 반쪽이 될 수 있다). system 프롬프트도 알린다 */
/** v2.2: 문단이 3~5문장으로 길어져 문단 상한을 800 → 1000자로 올렸다(5문장 × 80자 = 400자의 두 배 넘는 여유) */
export const MAX_CHARS = { headline: 80, dek: 200, title: 60, paragraph: 1000, icon: 8 } as const;
const length = (text: string) => Array.from(text).length;

/** 마지막 구성(마무리) 섹션 몫으로 따로 남겨 두는 근거 수. 그 섹션이 쓰는 만큼만(많아야 이만큼) 남긴다 */
export const CLOSING_QUOTE_RESERVE = 2;
/**
 * 글 안의 인용(Fix 2). 한국어 독자에게는 어느 따옴표든 그 멤버의 말로 읽히므로 따옴표 모양마다 원문과 대 본다.
 * 곧은·둥근 큰따옴표, 둥근 작은따옴표, 낫표·겹낫표는 늘 인용이다.
 * 곧은 작은따옴표 '…'는 별명·상 이름·자막에도 쓰므로(system 프롬프트가 그렇게 시킨다) 바로 뒤에 말을 옮기는 토씨가 붙을 때만 인용이다.
 * 단 '…'이라고 부르는 별명('선톡왕'이라고 불린다)은 인용이 아니다(토씨 뒤가 부르다·불리다)
 */
const INLINE_QUOTE = /"([^"]+)"|“([^”]+)”|‘([^’]+)’|「([^」]+)」|『([^』]+)』|'([^'\n]+)'(?=\s?(?:이?라고|이?라며|하고|하며|며)(?!\s*(?:부|불)))/g;

/**
 * 글 안의 인용이 모두 보낸 메시지의 부분 문자열인가. corpus는 보낸 메시지 본문을 줄바꿈으로 바꿔 \u0000으로 이은 글이다.
 * 길이 하한이 없다: 진짜 짧은 인용("응"·"ㅋㅋ")은 어차피 원문의 부분 문자열이라 지워지지 않고, 하한은 지어낸 짧은 말("사랑해")만 통과시킨다.
 * 섹션의 근거 인용도 보낸 메시지의 부분 문자열이므로 근거와 맞춰 보는 일은 이것으로 함께 된다
 */
const inlineQuotesOk = (text: string, corpus: () => string) => {
  for (const match of text.matchAll(INLINE_QUOTE)) {
    const quote = toNewlines(match.slice(1).find((g) => g !== undefined) ?? "").trim();
    if (quote !== "" && !corpus().includes(quote)) return false;
  }
  return true;
};

/**
 * 풀리는 {{stat:경로}} 자리표시자를 뺀 글. 경로 속 표시 이름이 링크 끝과 같은 말(Me·Com)이어도 개인정보로 보지 않게 한다.
 * 풀리지 않는 자리표시자는 남겨서 그 속의 개인정보도 검사한다
 */
const withoutStats = (text: string, stats: ChatStats) =>
  text.replace(PLACEHOLDER, (whole, inner: string) =>
    inner.startsWith(STAT) && resolveStat(inner.slice(STAT.length), stats) !== null ? "" : whole,
  );
/** 저장해도 되는 모델 글인가: 금지 표현·개인정보(PRD 5장 6)가 없고 글자 수 상한 이하(PRD 5장 1) */
const storable = (text: string, max: number, stats: ChatStats) =>
  length(text) <= max && !isBanned(text) && !hasPII(withoutStats(text, stats));
/** 제목·headline·dek: 저장할 수 없거나 원문에 없는 큰따옴표 인용이 들었으면 비운다 */
const clean = (text: string, max: number, stats: ChatStats, corpus: () => string) =>
  storable(text, max, stats) && inlineQuotesOk(text, corpus) ? text : "";
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

export function validateReport(
  raw: unknown,
  idx: Index,
  stats: ChatStats,
  opts: { truncated: boolean; tone: Tone; members: string[] },
): ValidateResult {
  const none = { paragraphs: 0, evidence: 0 };
  // safety가 먼저다: 걸린 응답이 구조 검사에서 failed가 되면 도움 안내 대신 [다시 쓰기]가 보이고,
  // 같은 위험 대화가 다시 유료 호출로 간다
  const flag = rawSafetyFlag(raw);
  if (flag !== null && flag !== "none") return { status: "safety", content: null, dropped: none };
  const parsed = reportSchema.safeParse(prepare(raw, opts.truncated));
  if (!parsed.success) return { status: "failed", content: null, dropped: none };
  const report = parsed.data;

  const named = codesToNames(opts.members);
  const parts = new Set<string>(TONES[opts.tone].parts.map((p) => p.key));
  const closingPart = TONES[opts.tone].parts.at(-1)?.key;
  const people = Object.keys(stats.byPerson);
  // 큰따옴표 인용을 맞춰 볼 보낸 메시지 본문. 인용이 있을 때 한 번만 만든다
  let corpusText: string | null = null;
  const corpus = () => (corpusText ??= Array.from(idx.values(), (line) => toNewlines(line.text)).join("\u0000"));
  const paragraphsIn = report.sections.reduce((n, s) => n + s.paragraphs.length, 0);
  const evidenceIn = report.sections.reduce((n, s) => n + s.evidence.length, 0);

  // 1차: 섹션마다 남을 문단과 그 문단이 쓰는 근거를 정한다. 근거 몫과 상관없이 정해진다
  const judged = report.sections.flatMap((section) => {
    // 1) 근거: 보낸 줄에 있고 본문의 부분 문자열인 것만(원문 일치), 같은 id는 처음 것만
    const valid: StoredSection["evidence"] = [];
    for (const e of section.evidence) {
      const line = idx.get(e.msg_id);
      const quote = toNewlines(e.quote);
      if (!line || quote.trim() === "" || valid.some((v) => v.id === e.id)) continue;
      if (!toNewlines(line.text).includes(quote)) continue;
      valid.push({ id: e.id, msg_id: e.msg_id, quote, sender: line.sender, at: line.at });
    }
    const verified = new Set(valid.map((e) => e.id));

    // 2) 문단: 글 검사(빈 글·자리표시자·금지 표현·개인정보·글자 수·큰따옴표 인용)와 가짜 근거 검사.
    // 근거를 달았는데 원문과 맞는 것이 하나도 없으면 지운다. evidence_ids는 원문과 맞은 것만 남긴다
    const aboutPerson = people.includes(section.about);
    const written = section.paragraphs.flatMap((p): (Paragraph & { placeholders: number })[] => {
      const text = named(p.text);
      const placeholders = placeholderCount(text, stats);
      if (text.trim() === "" || placeholders === null || !storable(text, MAX_CHARS.paragraph, stats)) return [];
      if (!inlineQuotesOk(text, corpus)) return [];
      const ids = p.evidence_ids.filter((id) => verified.has(id));
      if (p.evidence_ids.length > 0 && ids.length === 0) return [];
      return [{ ...p, text, evidence_ids: ids, placeholders }];
    });
    // 3) 사람 근거(섹션 단위): 근거를 달지 않은 문단만 본다. 원문과 맞은 근거를 쓰는 문단이나 자리표시자가 섹션 어디든 있으면 된다.
    // 근거를 단 문단은 2)를 지났으면 원문과 맞은 근거가 있으므로 grounded가 참이라 여기서 지워지지 않는다
    const grounded = written.some((p) => p.evidence_ids.length > 0 || p.placeholders > 0);
    const isPerson = (text: string) => aboutPerson || people.some((name) => text.includes(name));
    const paragraphs = written.filter((p) => grounded || !isPerson(p.text)).map(({ placeholders: _placeholders, ...p }) => p);
    // 문단이 다 지워진 섹션은 빼고, 그 근거는 몫에서 쓰지 않는다
    if (paragraphs.length === 0) return [];
    // 남는 문단이 쓰는 근거만 몫을 센다(고아 근거는 버린다)
    const used = new Set(paragraphs.flatMap((p) => p.evidence_ids));
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
    const kept = new Set(evidence.map((e) => e.id));
    quotesLeft -= evidence.length;
    if (closing) reserveLeft = Math.max(0, reserveLeft - evidence.length);
    paragraphsOut += j.paragraphs.length;
    evidenceOut += evidence.length;
    return {
      ...j.section,
      part: parts.has(j.section.part) ? j.section.part : "",
      icon: cleanIcon(j.section.icon),
      title: clean(named(j.section.title), MAX_CHARS.title, stats, corpus),
      about: ABOUT_FIXED.has(j.section.about) || j.aboutPerson ? j.section.about : "group",
      paragraphs: j.paragraphs.map((p, i) => ({ ...p, key: `p${i + 1}`, evidence_ids: p.evidence_ids.filter((id) => kept.has(id)) })),
      evidence,
    };
  });

  const dropped = { paragraphs: paragraphsIn - paragraphsOut, evidence: evidenceIn - evidenceOut };
  if (sections.length === 0) return { status: "failed", content: null, dropped };
  const content: StoredReport = {
    ...report,
    reading_notes: sanitizeNotes(report.reading_notes.map((n) => ({ ...n, note: named(n.note) }))),
    headline: clean(named(report.headline), MAX_CHARS.headline, stats, corpus),
    dek: clean(named(report.dek), MAX_CHARS.dek, stats, corpus),
    sections,
  };
  const partial = opts.truncated || dropped.paragraphs / paragraphsIn >= PARTIAL_DROP_RATIO;
  return { status: partial ? "partial" : "done", content, dropped };
}
