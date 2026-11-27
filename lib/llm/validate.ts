// 저장 전 검증(PRD 5장, v2 설계 G7). 서버 전용. 검증을 거치지 않은 문장은 저장하지도 보여 주지도 않는다.
// safety: 구조 검사보다 먼저 원본에서 본다. flag가 none이 아닌 문자열이면 다른 필드가 틀려도 도움 안내로 간다.
// 근거: msg_id가 보낸 줄에 있고 quote가 그 본문의 부분 문자열이어야 남는다. 어느 문단도 쓰지 않는 근거는 버리고,
//   남은 것을 리포트 전체 MAX_QUOTES_PER_REPORT개까지 앞 섹션부터 센다(고아 근거가 뒤 구성의 몫을 먹지 않게).
// 문단: 풀리지 않는 자리표시자, 금지 표현·개인정보가 든 문단, 너무 긴 문단을 지운다. 남은 문단 키는 섹션마다 p1, p2…
// 사람 근거(v2.2): 섹션 단위다. 사람을 다루는 섹션(about이 참여자이거나 문단에 이름이 나온다)은 남은 근거 인용이나
//   풀리는 자리표시자가 섹션 어디든 하나 있으면 된다. 문단마다 근거를 달 필요는 없다. 둘 다 없으면 이름이 든 문단(about이 사람이면 전부)을 지운다.
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
const clean = (text: string, max: number, stats: ChatStats) => (storable(text, max, stats) ? text : "");
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
  const people = Object.keys(stats.byPerson);
  let quotesLeft = MAX_QUOTES_PER_REPORT;
  let paragraphsIn = 0;
  let paragraphsOut = 0;
  let evidenceIn = 0;
  let evidenceOut = 0;
  const sections: StoredSection[] = [];

  for (const section of report.sections) {
    paragraphsIn += section.paragraphs.length;
    evidenceIn += section.evidence.length;

    // 1) 근거: 보낸 줄에 있고 본문의 부분 문자열인 것만, 같은 id는 처음 것만
    const valid: StoredSection["evidence"] = [];
    for (const e of section.evidence) {
      const line = idx.get(e.msg_id);
      const quote = toNewlines(e.quote);
      if (!line || quote.trim() === "" || valid.some((v) => v.id === e.id)) continue;
      if (!toNewlines(line.text).includes(quote)) continue;
      valid.push({ id: e.id, msg_id: e.msg_id, quote, sender: line.sender, at: line.at });
    }

    // 2) 문단: 글 검사(빈 글·자리표시자·금지 표현·개인정보·글자 수)만 본다. 근거는 섹션 단위로 아래에서 본다
    const aboutPerson = people.includes(section.about);
    const written = section.paragraphs.flatMap((p): (Paragraph & { placeholders: number })[] => {
      const text = named(p.text);
      const placeholders = placeholderCount(text, stats);
      if (text.trim() === "" || placeholders === null || !storable(text, MAX_CHARS.paragraph, stats)) return [];
      return [{ ...p, text, placeholders }];
    });
    // 남는 문단이 쓰는 근거만 몫을 센다. 남는 문단은 근거와 상관없이 정해지므로 한 번에 센다
    const used = new Set(written.flatMap((p) => p.evidence_ids));
    const evidence = valid.filter((e) => used.has(e.id)).slice(0, quotesLeft);
    const kept = new Set(evidence.map((e) => e.id));
    // 3) 사람 근거(섹션 단위): 남은 근거 인용이나 자리표시자가 섹션 어디든 있으면 된다. 없으면 이름이 든 문단을 지운다.
    // 근거가 없을 때만 지우므로 지운 문단이 몫을 쓰고 있던 일은 없다
    const grounded = evidence.length > 0 || written.some((p) => p.placeholders > 0);
    const isPerson = (text: string) => aboutPerson || people.some((name) => text.includes(name));
    const paragraphs = written
      .filter((p) => grounded || !isPerson(p.text))
      .map(({ placeholders: _placeholders, ...p }, i) => ({ ...p, key: `p${i + 1}`, evidence_ids: p.evidence_ids.filter((id) => kept.has(id)) }));

    // 문단이 다 지워진 섹션은 빼고, 그 근거는 몫에서 쓰지 않는다
    if (paragraphs.length === 0) continue;
    quotesLeft -= evidence.length;
    paragraphsOut += paragraphs.length;
    evidenceOut += evidence.length;
    sections.push({
      ...section,
      part: parts.has(section.part) ? section.part : "",
      icon: cleanIcon(section.icon),
      title: clean(named(section.title), MAX_CHARS.title, stats),
      about: ABOUT_FIXED.has(section.about) || aboutPerson ? section.about : "group",
      paragraphs,
      evidence,
    });
  }

  const dropped = { paragraphs: paragraphsIn - paragraphsOut, evidence: evidenceIn - evidenceOut };
  if (sections.length === 0) return { status: "failed", content: null, dropped };
  const content: StoredReport = {
    ...report,
    reading_notes: sanitizeNotes(report.reading_notes.map((n) => ({ ...n, note: named(n.note) }))),
    headline: clean(named(report.headline), MAX_CHARS.headline, stats),
    dek: clean(named(report.dek), MAX_CHARS.dek, stats),
    sections,
  };
  const partial = opts.truncated || dropped.paragraphs / paragraphsIn >= PARTIAL_DROP_RATIO;
  return { status: partial ? "partial" : "done", content, dropped };
}
