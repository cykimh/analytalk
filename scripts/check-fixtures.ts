// 테스트 파일(test/fixtures) 검사: 실제 이름·전화번호·이메일·URL·방 이름이 커밋되지 않게 막는다.
//
//   pnpm check:fixtures            test/fixtures 전체 (CI)
//   pnpm check:fixtures --staged   스테이징된 test/fixtures 파일만, 스테이징된 내용으로 (pre-commit)
//   pnpm check:fixtures <파일…>     주어진 파일만
//
// 공개 저장소의 CI 로그에 남지 않도록 오류 문구에는 찾아낸 값(이름·번호)을 싣지 않는다.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodeBytes } from "../lib/parse/decode";
import { detectFormat, detectionSample } from "../lib/parse/detect";
import { headerLength, normalizeLine, parseNotice, readCsvRecords, splitLines, TEXT_FORMATS } from "../lib/parse/formats";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE_DIR = join(ROOT, "test/fixtures");
/** test/fixtures 안이지만 픽스처가 아닌 설정 파일 */
const META_FILES = new Set(["ALLOWED_NAMES", ".gitattributes"]);

export const ROOM_NAME = "테스트방";
/** 픽스처에 쓸 수 있는 이름. 사람 이름 5개와 방 이름 */
export const ALLOWED_NAMES: readonly string[] = readFileSync(join(FIXTURE_DIR, "ALLOWED_NAMES"), "utf8")
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean);
const ALLOWED = new Set(ALLOWED_NAMES);

const FIXTURE_NAME = /^[a-z0-9-]+\.(txt|csv)$/;
const ROOM_TITLE = /^(.+?)(?: 님과)? 카카오톡 대화$/;
const PII: [label: string, re: RegExp][] = [
  ["전화번호", /(?<!\d)(?:\+82[- ]?|0)(?:1[016789]|2|[3-6][1-5]|70)[- .]?\d{3,4}[- .]?\d{4}(?!\d)/g],
  ["이메일", /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g],
  ["URL", /\bhttps?:\/\/\S+|\bwww\.\S+/gi],
];

/** 이름을 글자 덩어리로 나눠 모두 ALLOWED_NAMES 안인지 본다. `[지훈]`, `민지, 수아`, 빈 이름은 통과한다 */
const isAllowedName = (name: string) => name.split(/[^\p{L}\p{N}]+/u).every((t) => t === "" || ALLOWED.has(t));

/** 픽스처 한 개의 오류 목록. 맨 앞 `# …` 줄(예: `# ASSUMED: …`)은 메타 정보로 보고 헤더 검사에서 건너뛴다 */
export function checkFixture(fileName: string, text: string): string[] {
  const errors: string[] = [];
  if (!FIXTURE_NAME.test(basename(fileName))) errors.push(`파일 이름이 ${FIXTURE_NAME.source} 규칙을 따르지 않는다`);

  const lines = splitLines(text.replace(/^\uFEFF/, ""));
  lines.forEach((line, i) => {
    for (const [label, re] of PII) for (const _ of line.matchAll(re)) errors.push(`${i + 1}행: ${label}`);
  });

  let start = 0;
  while (start < lines.length && lines[start].startsWith("# ")) start++;
  const title = lines[start] ?? "";
  const room = ROOM_TITLE.exec(title);
  if ((room && room[1] !== ROOM_NAME) || /^Talk_/.test(title)) {
    errors.push(`${start + 1}행: 헤더 방 이름이 ${ROOM_NAME}가 아니다`);
  }

  const bodyStart = start + headerLength(lines.slice(start));
  for (const at of badNameLines(lines, bodyStart)) errors.push(at === null ? "형식을 알아볼 수 없어 이름을 검사하지 못했다" : `${at}행: ALLOWED_NAMES 밖의 이름`);
  return errors;
}

/**
 * 발신자·시스템 줄의 이름이 허용 목록 밖인 줄 번호들. 형식을 알 수 없으면 [null].
 * 형식 감지는 파서와 같은 표본 함수(공백 정규화 포함)로 한다. 판단이 갈리면 이름 검사를 통째로 건너뛸 수 있다
 */
function badNameLines(lines: string[], bodyStart: number): (number | null)[] {
  const { formatId } = detectFormat(detectionSample([{ lines, header: bodyStart }]));
  if (formatId === null) return [null];

  const body = lines.slice(bodyStart);
  const bad: number[] = [];
  const check = (names: string[], lineNo: number) => {
    for (const name of names) if (!isAllowedName(name)) bad.push(lineNo);
  };
  if (formatId === "mac-csv") {
    for (const { fields, line } of readCsvRecords(body.join("\n"))) {
      const [, user = "", message = ""] = fields;
      check([user, ...(parseNotice(message)?.names ?? [])], bodyStart + line);
    }
    return bad;
  }
  const fmt = TEXT_FORMATS[formatId];
  body.forEach((raw, i) => {
    const line = normalizeLine(raw);
    const msg = fmt.message(line);
    if (msg) return check([msg.sender], bodyStart + i + 1);
    if (fmt.dateLine(line)) return;
    const notice = fmt.notice(line);
    if (notice) check(parseNotice(notice.text)?.names ?? [], bodyStart + i + 1);
  });
  return bad;
}

function listFixtures(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return listFixtures(path);
    return META_FILES.has(e.name) ? [] : [path];
  });
}

function stagedFixtures(): { path: string; bytes: Uint8Array }[] {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, maxBuffer: 1 << 28 });
  return git("diff", "--cached", "--name-only", "--diff-filter=ACM", "-z")
    .toString("utf8")
    .split("\0")
    .filter((p) => p.startsWith("test/fixtures/") && !META_FILES.has(basename(p)))
    .map((p) => ({ path: p, bytes: git("show", `:${p}`) }));
}

function main(args: string[]): void {
  const files = args.includes("--staged")
    ? stagedFixtures()
    : (args.length > 0 ? args : listFixtures(FIXTURE_DIR)).map((p) => ({
        path: relative(ROOT, p) || p,
        bytes: readFileSync(p),
      }));
  let failed = 0;
  for (const { path, bytes } of files) {
    const errors = checkFixture(path, decodeBytes(bytes));
    for (const e of errors) console.error(`${path}: ${e}`);
    if (errors.length > 0) failed++;
  }
  if (failed > 0) {
    console.error(`픽스처 검사 실패: ${failed}/${files.length}개 파일`);
    process.exit(1);
  }
  console.log(`픽스처 검사 통과: ${files.length}개 파일`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
