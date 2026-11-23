// 실제 내보내기 파일을 줄 모양만 남긴 가짜 대화(테스트 파일)로 바꾼다.
//
//   pnpm skeletonize <파일> [--names 이름1,이름2] [--shift-weeks N] > test/fixtures/<formatId>.txt
//
// 처음 40줄만 읽는다. 이름은 파서가 찾은 발신자·시스템 줄 이름에 --names를 더한 것이다.
// 결과는 꼭 눈으로 확인하고 `pnpm check:fixtures <파일>`로 검사한다.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { decodeBytes } from "../lib/parse/decode";
import { ALLOWED_NAMES, ROOM_NAME } from "./check-fixtures";

const HEAD_LINES = 40;
const PERSON_NAMES = ALLOWED_NAMES.filter((n) => n !== ROOM_NAME);
const TITLE = `${ROOM_NAME} 님과 카카오톡 대화`;
/** 이름 자리표시자: 사용 영역 글자 하나 = PERSON_NAMES의 순번 */
const PLACEHOLDER = 0xe000;
const PLACEHOLDER_RE = /[\uE000-\uE0FF]/g;

// 형식 키워드. lib/parse/formats.ts의 줄 모양·사전이 쓰는 글자를 남겨 골격화한 파일도 같은 형식으로 읽히게 한다.
// 날짜·시각 자리의 숫자도 여기서 지킨다(본문 속 다른 숫자는 0이 된다).
const KEYWORDS = [
  "삭제된 메시지입니다",
  "초대하였습니다",
  "초대했습니다",
  "들어왔습니다",
  "나갔습니다",
  "카카오톡 대화",
  "저장한 날짜",
  "이모티콘",
  "동영상",
  "님과",
  "님이",
  "님을",
  "오전",
  "오후",
  "사진",
  "초대",
  "파일",
];
const KEEP = new RegExp(
  [
    "[\\uE000-\\uE0FF]",
    "(?<!\\d)(?:19|20)\\d{2}-[01]\\d-[0-3]\\d(?!\\d)",
    "(?<!\\d)\\d{4}\\. \\d{1,2}\\. \\d{1,2}\\.",
    "(?<!\\d)\\d{1,4}[년월일]",
    "(?<!\\d)\\d{1,2}:\\d{2}(?::\\d{2})?(?!\\d)",
    "[월화수목금토일]요일",
    ...KEYWORDS,
  ].join("|"),
  "gu",
);

/** 한글은 '가', 숫자는 '0', 그 밖의 글자(영문 등)는 'a'. 구두점·공백·기호는 그대로 */
const maskChars = (s: string) =>
  s.replace(/[\p{L}\p{Nd}]/gu, (c) => (/\p{Script=Hangul}/u.test(c) ? "가" : /\p{Nd}/u.test(c) ? "0" : "a"));

function maskLine(line: string): string {
  let out = "";
  let last = 0;
  for (const m of line.matchAll(KEEP)) {
    out += maskChars(line.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + maskChars(line.slice(last));
}

/** 첫 줄: 방 이름 줄이면 테스트방 헤더로, CSV 머리면 그대로, 아니면 다른 줄과 같게 */
function maskFirstLine(line: string): string {
  const bom = line.startsWith("\uFEFF") ? "\uFEFF" : "";
  const cr = line.endsWith("\r") ? "\r" : "";
  const core = line.slice(bom.length, line.length - cr.length);
  if (core === "Date,User,Message") return line;
  if (/^.+ 카카오톡 대화$/.test(core) || /^Talk_/.test(core)) return `${bom}${TITLE}${cr}`;
  return maskLine(line);
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const shiftDay = (y: string, mo: string, d: string, weeks: number) => {
  const t = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d) + 7 * weeks));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
};

/** 날짜를 weeks주(7의 배수 일수)만큼 민다. 요일 이름은 그대로 맞는다 */
function shiftDates(text: string, weeks: number): string {
  return text
    .replace(/(?<!\d)(\d{4})년 (\d{1,2})월 (\d{1,2})일/g, (_, y, mo, d) => {
      const t = shiftDay(y, mo, d, weeks);
      return `${t.y}년 ${t.mo}월 ${t.d}일`;
    })
    .replace(/(?<!\d)(\d{4})\. (\d{1,2})\. (\d{1,2})\./g, (_, y, mo, d) => {
      const t = shiftDay(y, mo, d, weeks);
      return `${t.y}. ${t.mo}. ${t.d}.`;
    })
    .replace(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g, (_, y, mo, d) => {
      const t = shiftDay(y, mo, d, weeks);
      return `${t.y}-${pad2(t.mo)}-${pad2(t.d)}`;
    });
}

/**
 * 파서 없이 줄 모양만 남긴다.
 * - 첫 줄(방 이름)은 `테스트방 님과 카카오톡 대화`로
 * - names[i]는 ALLOWED_NAMES의 i번째 사람 이름으로 1:1 치환한다(긴 이름부터, 발신자·시스템 줄·본문 모두)
 * - 형식 키워드·날짜·시각 숫자·구두점은 남기고, 나머지 한글은 '가', 숫자는 '0', 영문은 'a'
 * - shiftWeeks를 주면 날짜를 7의 배수 일수만큼 민다
 */
export function skeletonize(text: string, names: string[], opts: { shiftWeeks?: number } = {}): string {
  const weeks = opts.shiftWeeks ?? 0;
  if (!Number.isInteger(weeks)) throw new Error("shiftWeeks는 정수여야 한다(7의 배수 일수만 민다)");
  const unique = [...new Set(names.filter((n) => n !== ""))];
  if (unique.length > PERSON_NAMES.length) {
    throw new Error(`이름이 ${unique.length}개라 ALLOWED_NAMES의 사람 이름 ${PERSON_NAMES.length}개보다 많다`);
  }

  let body = text.replace(PLACEHOLDER_RE, "?");
  const longestFirst = unique.map((name, i) => ({ name, i })).sort((a, b) => b.name.length - a.name.length);
  for (const { name, i } of longestFirst) body = body.split(name).join(String.fromCharCode(PLACEHOLDER + i));
  if (weeks !== 0) body = shiftDates(body, weeks);

  return body
    .split("\n")
    .map((line, i) => (i === 0 ? maskFirstLine(line) : maskLine(line)))
    .join("\n")
    .replace(PLACEHOLDER_RE, (c) => PERSON_NAMES[c.charCodeAt(0) - PLACEHOLDER]);
}

async function main(args: string[]): Promise<void> {
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  const extraNames = (flag("--names") ?? "").split(",").map((s) => s.trim());
  const shiftWeeks = Number(flag("--shift-weeks") ?? 0);
  const [file] = args;
  if (!file) {
    console.error("사용법: pnpm skeletonize <파일> [--names 이름1,이름2] [--shift-weeks N]");
    process.exit(2);
  }
  const bytes = readFileSync(file);
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? "\uFEFF" : "";
  const head = decodeBytes(bytes).split("\n").slice(0, HEAD_LINES).join("\n");
  // 이름 찾기에만 파서를 쓴다. skeletonize 자체는 파서 없이 동작한다
  const { parseExport } = await import("../lib/parse/parse");
  const parsed = parseExport([{ name: "head.txt", text: head }]);
  const names = [...parsed.participants, ...parsed.systemNames, ...extraNames];
  try {
    const out = skeletonize(bom + head, names, { shiftWeeks });
    process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main(process.argv.slice(2));
