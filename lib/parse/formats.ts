// 카카오톡 내보내기 형식표와 사전. DOM 없이 브라우저·node에서 함께 쓴다.
//
// 줄 모양은 zeikar/kakaotalk-viewer(MIT, Copyright (c) zeikar) src/parser/{android,ios,windows,mac}.ts의
// 정규식을 참고해 다시 썼다. 형식마다 하나의 표로 모으고, 모든 정규식을 줄 맨 앞(^)에 고정했다.

export type FormatId = "android-ko" | "android-ko-legacy" | "ios-ko-dot" | "ios-ko-time" | "windows-ko" | "mac-csv";
export type TextFormatId = Exclude<FormatId, "mac-csv">;
// call·other는 실기기 문자열을 확인하기 전까지 만들지 않는다(사전에 없는 것은 인정하지 않는다)
export type MsgKind = "text" | "photo" | "video" | "emoticon" | "file" | "deleted" | "system" | "call" | "other";

/** 감지 동점일 때 앞의 것이 이긴다 */
export const FORMAT_IDS: readonly FormatId[] = [
  "android-ko",
  "android-ko-legacy",
  "ios-ko-dot",
  "ios-ko-time",
  "windows-ko",
  "mac-csv",
];

export interface Day {
  y: number;
  mo: number;
  d: number;
}
/** 줄 머리의 시각. day가 null이면 직전 날짜 구분선의 날짜를 쓴다 */
export interface Stamp {
  day: Day | null;
  h: number;
  mi: number;
  s: number;
}
export interface MessageLine {
  stamp: Stamp;
  sender: string;
  body: string;
}
export interface NoticeLine {
  /** null이면 시각이 없는 줄(Windows)이라 직전 시각을 쓴다 */
  stamp: Stamp | null;
  text: string;
}
export interface TextFormat {
  id: TextFormatId;
  message(line: string): MessageLine | null;
  dateLine(line: string): Day | null;
  /** 시스템 줄 후보. 사전과 맞는지는 parseNotice가 따진다 */
  notice(line: string): NoticeLine | null;
  /** 메시지·시스템 줄의 머리 모양. 머리는 맞는데 해석이 안 되는 줄은 인식 실패로 센다 */
  head: RegExp;
}

const KST_OFFSET_MS = 9 * 3_600_000;

/** KST 벽시계 시각 → UTC epoch ms */
export function kstEpoch(day: Day, h = 0, mi = 0, s = 0): number {
  return Date.UTC(day.y, day.mo - 1, day.d, h, mi, s) - KST_OFFSET_MS;
}

/** 오전 12시는 0시, 오후 12시는 12시 */
export function to24h(ampm: string | undefined, h: number): number {
  if (ampm === "오전") return h === 12 ? 0 : h;
  if (ampm === "오후") return h === 12 ? 12 : h + 12;
  return h;
}

const AMPM = "(오전|오후) (\\d{1,2}):(\\d{2})";
const KO_DAY = "(\\d{4})년 (\\d{1,2})월 (\\d{1,2})일";
const DOT_DAY = "(\\d{4})\\. (\\d{1,2})\\. (\\d{1,2})\\.";
const WEEKDAY = "[월화수목금토일]요일";
// ios-ko-time 머리 뒤에 구형 Android의 날짜가 오면 그 형식의 줄이다
const NOT_LEGACY_DAY = "(?!\\d{4}년 \\d{1,2}월 \\d{1,2}일(?:,|$))";

const num = (s: string) => Number.parseInt(s, 10);
const day = (y: string, mo: string, d: string): Day => ({ y: num(y), mo: num(mo), d: num(d) });

/**
 * "머리, 발신자 : 본문" / "머리, 알림" 모양(Android·iOS)의 형식을 만든다.
 * stampGroups: 머리 정규식의 캡처 그룹 수. readStamp는 그 그룹들로 시각을 만든다.
 */
function stampedFormat(
  id: TextFormatId,
  stamp: string,
  stampGroups: number,
  readStamp: (g: string[]) => Stamp,
  dateLine: RegExp,
  readDay: (g: string[]) => Day,
  guard = "",
): TextFormat {
  const messageRe = new RegExp(`^${stamp}, ${guard}(.*?) : (.*)$`);
  const noticeRe = new RegExp(`^${stamp}, ${guard}(.+)$`);
  return {
    id,
    head: new RegExp(`^${stamp}, ${guard}`),
    message(line) {
      const m = messageRe.exec(line);
      if (!m) return null;
      return { stamp: readStamp(m.slice(1)), sender: m[stampGroups + 1], body: m[stampGroups + 2] };
    },
    dateLine(line) {
      const m = dateLine.exec(line);
      return m ? readDay(m.slice(1)) : null;
    },
    notice(line) {
      const m = noticeRe.exec(line);
      return m ? { stamp: readStamp(m.slice(1)), text: m[stampGroups + 1] } : null;
    },
  };
}

const WINDOWS_MESSAGE = /^\[(.*?)\] \[(?:(오전|오후) )?(\d{1,2}):(\d{2})\](?: (.*))?$/;
const WINDOWS_DATE = new RegExp(`^-+ ${KO_DAY} ${WEEKDAY} -+$`);

export const TEXT_FORMATS: Record<TextFormatId, TextFormat> = {
  // 2016년 2월 5일 오전 1:33, 민지 : 본문
  "android-ko": stampedFormat(
    "android-ko",
    `${KO_DAY} ${AMPM}`,
    6,
    ([y, mo, d, ap, h, mi]) => ({ day: day(y, mo, d), h: to24h(ap, num(h)), mi: num(mi), s: 0 }),
    new RegExp(`^${KO_DAY} ${AMPM}$`),
    ([y, mo, d]) => day(y, mo, d),
  ),
  // 오후 10:50, 2011년 11월 6일, 민지 : 본문
  "android-ko-legacy": stampedFormat(
    "android-ko-legacy",
    `${AMPM}, ${KO_DAY}`,
    6,
    ([ap, h, mi, y, mo, d]) => ({ day: day(y, mo, d), h: to24h(ap, num(h)), mi: num(mi), s: 0 }),
    new RegExp(`^${AMPM}, ${KO_DAY}$`),
    ([, , , y, mo, d]) => day(y, mo, d),
  ),
  // 2024. 3. 14. 오후 7:12, 민지 : 본문
  "ios-ko-dot": stampedFormat(
    "ios-ko-dot",
    `${DOT_DAY} ${AMPM}`,
    6,
    ([y, mo, d, ap, h, mi]) => ({ day: day(y, mo, d), h: to24h(ap, num(h)), mi: num(mi), s: 0 }),
    new RegExp(`^${KO_DAY} ${WEEKDAY}$`),
    ([y, mo, d]) => day(y, mo, d),
  ),
  // 오후 8:36, 민지 : 본문 (날짜는 "2021년 12월 29일 수요일" 구분선에서)
  "ios-ko-time": stampedFormat(
    "ios-ko-time",
    AMPM,
    3,
    ([ap, h, mi]) => ({ day: null, h: to24h(ap, num(h)), mi: num(mi), s: 0 }),
    new RegExp(`^${KO_DAY} ${WEEKDAY}$`),
    ([y, mo, d]) => day(y, mo, d),
    NOT_LEGACY_DAY,
  ),
  // [민지] [오전 1:01] 본문 / [민지] [20:36] 본문, 시스템 줄은 시각 없이 사전 문구만
  "windows-ko": {
    id: "windows-ko",
    head: /^\[.*?\] \[(?:(?:오전|오후) )?\d{1,2}:\d{2}\]/,
    message(line) {
      const m = WINDOWS_MESSAGE.exec(line);
      if (!m) return null;
      return { stamp: { day: null, h: to24h(m[2], num(m[3])), mi: num(m[4]), s: 0 }, sender: m[1], body: m[5] ?? "" };
    },
    dateLine(line) {
      const m = WINDOWS_DATE.exec(line);
      return m ? day(m[1], m[2], m[3]) : null;
    },
    notice(line) {
      return { stamp: null, text: line };
    },
  },
};

/** mac CSV 한 행: 2021-12-29 20:36:00,"민지","본문" */
export const CSV_HEADER = "Date,User,Message";
export const CSV_ROW_HEAD = /^(?:\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?)?,"/;
const CSV_DATE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/;

/** CSV 날짜 칸 → 시각. 빈 칸이면 null, 모양이 틀리면 undefined */
export function csvStamp(field: string): Stamp | null | undefined {
  if (field === "") return null;
  const m = CSV_DATE.exec(field);
  if (!m) return undefined;
  return { day: day(m[1], m[2], m[3]), h: num(m[4]), mi: num(m[5]), s: m[6] ? num(m[6]) : 0 };
}

export interface CsvRecord {
  fields: string[];
  /** 행이 시작하는 줄 번호(1부터) */
  line: number;
}

/** 따옴표 칸(""는 "), 칸 안 줄바꿈을 지원하는 CSV 읽기. 빈 줄은 건너뛴다 */
export function readCsvRecords(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  const n = text.length;
  let i = 0;
  let line = 1;
  const breaks = (s: string) => {
    let c = 0;
    for (let k = 0; k < s.length; k++) {
      const ch = s.charCodeAt(k);
      if (ch === 10 || (ch === 13 && s.charCodeAt(k + 1) !== 10)) c++;
    }
    return c;
  };
  while (i < n) {
    const start = line;
    const fields: string[] = [];
    for (;;) {
      let field = "";
      if (text[i] === '"') {
        i++;
        for (;;) {
          const q = text.indexOf('"', i);
          if (q < 0) {
            field += text.slice(i);
            i = n;
            break;
          }
          field += text.slice(i, q);
          if (text[q + 1] === '"') {
            field += '"';
            i = q + 2;
          } else {
            i = q + 1;
            break;
          }
        }
        line += breaks(field);
        field = field.replace(/\r\n?/g, "\n");
      }
      let j = i;
      while (j < n && text[j] !== "," && text[j] !== "\n" && text[j] !== "\r") j++;
      field += text.slice(i, j);
      i = j;
      fields.push(field);
      if (text[i] === ",") {
        i++;
        continue;
      }
      break;
    }
    if (text[i] === "\r") i++;
    if (text[i] === "\n") i++;
    line++;
    if (!(fields.length === 1 && fields[0] === "")) records.push({ fields, line: start });
  }
  return records;
}

/** 한 파일의 맨 앞 헤더 줄 수: 방 이름 줄(`… 카카오톡 대화`, `Talk_….txt`) 또는 CSV 머리, 그리고 `저장한 날짜 :` */
export function headerLength(lines: readonly string[]): number {
  let h = 0;
  const first = lines[0] ?? "";
  if (/^.+ 카카오톡 대화$/.test(first) || /^Talk_.*\.txt$/.test(first) || first === CSV_HEADER) h = 1;
  if (/^저장한 날짜 : /.test(lines[h] ?? "")) h++;
  return h;
}

/** \r\n, \r, \n 모두 줄바꿈으로 본다 */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

/** U+00A0·U+202F 공백을 보통 공백으로 */
export function normalizeLine(line: string): string {
  return /[\u00A0\u202F]/.test(line) ? line.replace(/[\u00A0\u202F]/g, " ") : line;
}

// 시스템 메시지 사전. 정확히 이 문구일 때만 시스템 메시지로 인정한다.
const INVITE = /^(?:(.+?)님이 )?(.+)님을 초대(?:하였|했)습니다\.$/;
const LEAVE = /^(.+)님이 나갔습니다\.$/;
const JOIN = /^(.+)님이 들어왔습니다\.$/;

/** 사전에 맞는 알림이면 그 안의 이름들, 아니면 null */
export function parseNotice(text: string): { names: string[] } | null {
  const inv = INVITE.exec(text);
  if (inv) {
    const invitees = inv[2].split(/님(?:, |과 )/);
    return { names: inv[1] ? [inv[1], ...invitees] : invitees };
  }
  const other = LEAVE.exec(text) ?? JOIN.exec(text);
  return other ? { names: [other[1]] } : null;
}

// 미디어 사전. 본문 전체가 정확히 일치할 때만(파일은 `파일:` 머리) 인정한다.
const MEDIA: ReadonlyMap<string, MsgKind> = new Map<string, MsgKind>([
  ["사진", "photo"],
  ["동영상", "video"],
  ["이모티콘", "emoticon"],
  ["삭제된 메시지입니다.", "deleted"],
]);

export function mediaKind(body: string): MsgKind {
  return MEDIA.get(body) ?? (body.startsWith("파일:") ? "file" : "text");
}
