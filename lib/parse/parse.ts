// 카카오톡 내보내기 파서. DOM 없이 브라우저(Web Worker)·node에서 함께 쓴다.
// 줄 판정 순서: 메시지 → 날짜 구분선 → 시스템(사전 일치) → 이어짐
import { detectFormat, detectionSample } from "./detect";
import {
  csvStamp,
  type Day,
  type FormatId,
  headerLength,
  kstEpoch,
  mediaKind,
  type MsgKind,
  normalizeLine,
  parseNotice,
  readCsvRecords,
  splitLines,
  type Stamp,
  TEXT_FORMATS,
  type TextFormat,
} from "./formats";

export type { FormatId, MsgKind } from "./formats";

export interface ChatMessage {
  /** 0부터 매기는 전체 순번 */
  id: number;
  /** KST 벽시계 시각을 UTC epoch ms로 바꾼 값(+09:00) */
  ts: number;
  /** 시스템 메시지와 빈 발신자 줄은 null */
  sender: string | null;
  kind: MsgKind;
  text: string;
  /** 합친 파일들(분할 순서)에서 이 메시지가 시작하는 줄 번호(1부터, 헤더 줄 포함) */
  line: number;
}

export interface ParseResult {
  formatId: FormatId | null;
  messages: ChatMessage[];
  /** 발신자 이름(처음 나온 순서) */
  participants: string[];
  /** 초대·나감·들어옴 줄에서 뽑은 이름(처음 나온 순서) */
  systemNames: string[];
  /**
   * 비어 있지 않은 본문 줄(CSV는 행) 중 해석한 비율. 이어짐 줄도 해석한 것으로 친다.
   * 해석 못 한 줄: 첫 메시지 앞의 줄, 머리 모양은 맞는데 사전·정규식에 안 맞는 줄, 날짜를 모르는 줄.
   * formatId가 null이면 감지 단계의 최고 매칭률(0.5 미만)이다.
   */
  recognizedRatio: number;
  /** 비어 있지 않은 본문 줄 중 직전 메시지에 이어 붙인 줄의 비율 */
  continuationRatio: number;
  firstTs: number | null;
  lastTs: number | null;
}

interface FilePart {
  lines: string[];
  /** 헤더 줄 수 */
  header: number;
}

const SPLIT_NAME = /^(.*)-(\d+)\.(?:txt|csv)$/i;

/** 분할 파일 `…-N.txt`를 (앞부분, N 숫자) 순서로 정렬한다. 그 밖의 파일은 이름 순 */
function orderFiles<T extends { name: string }>(files: T[]): T[] {
  const key = (f: T) => {
    const base = f.name.split(/[\\/]/).pop() ?? f.name;
    const m = SPLIT_NAME.exec(base);
    return m ? { base: m[1], n: Number(m[2]) } : { base, n: 0 };
  };
  return files
    .map((f) => ({ f, k: key(f) }))
    .sort((a, b) => (a.k.base < b.k.base ? -1 : a.k.base > b.k.base ? 1 : a.k.n - b.k.n))
    .map(({ f }) => f);
}

/** 여러 파일(분할 내보내기 포함)을 한 대화로 합쳐 읽는다 */
export function parseExport(files: { name: string; text: string }[]): ParseResult {
  const parts: FilePart[] = orderFiles(files).map(({ text }) => {
    const lines = splitLines(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return { lines, header: headerLength(lines) };
  });

  const { formatId, score } = detectFormat(detectionSample(parts));
  if (formatId === null) {
    return {
      formatId,
      messages: [],
      participants: [],
      systemNames: [],
      recognizedRatio: score,
      continuationRatio: 0,
      firstTs: null,
      lastTs: null,
    };
  }
  const acc = new Accumulator(formatId);
  if (formatId === "mac-csv") parseCsv(parts, acc);
  else parseText(TEXT_FORMATS[formatId], parts, acc);
  return acc.result();
}

class Accumulator {
  readonly messages: ChatMessage[] = [];
  private readonly senders = new Set<string>();
  private readonly systemNames = new Set<string>();
  total = 0;
  unrecognized = 0;
  continuation = 0;

  constructor(private readonly formatId: FormatId) {}

  /** sender가 비어 있으면 시스템 메시지(빈 발신자 줄 포함)로 둔다. names는 그 줄의 알림 속 이름 */
  add(ts: number, sender: string | null, text: string, line: number, names?: string[]): void {
    const who = sender !== null && sender.trim() !== "" ? sender : null;
    if (who !== null) this.senders.add(who);
    else for (const name of names ?? parseNotice(text)?.names ?? []) this.systemNames.add(name);
    this.messages.push({ id: this.messages.length, ts, sender: who, kind: who === null ? "system" : "text", text, line });
  }

  result(): ParseResult {
    let firstTs: number | null = null;
    let lastTs: number | null = null;
    for (const m of this.messages) {
      if (m.kind !== "system") m.kind = mediaKind(m.text);
      if (firstTs === null || m.ts < firstTs) firstTs = m.ts;
      if (lastTs === null || m.ts > lastTs) lastTs = m.ts;
    }
    const { total } = this;
    return {
      formatId: this.formatId,
      messages: this.messages,
      participants: [...this.senders],
      systemNames: [...this.systemNames],
      recognizedRatio: total === 0 ? 0 : (total - this.unrecognized) / total,
      continuationRatio: total === 0 ? 0 : this.continuation / total,
      firstTs,
      lastTs,
    };
  }
}

function stampTs(stamp: Stamp, current: Day | null): number | null {
  const day = stamp.day ?? current;
  return day === null ? null : kstEpoch(day, stamp.h, stamp.mi, stamp.s);
}

function parseText(fmt: TextFormat, parts: FilePart[], acc: Accumulator): void {
  let day: Day | null = null;
  /** 시각이 없는 시스템 줄(Windows)에 쓸 직전 시각 */
  let cursor: number | null = null;
  let lineNo = 0;
  for (const { lines, header } of parts) {
    let pendingBlank = 0;
    for (let i = 0; i < lines.length; i++) {
      lineNo++;
      if (i < header) continue;
      const line = normalizeLine(lines[i]);
      if (line.trim() === "") {
        pendingBlank++;
        continue;
      }
      acc.total++;

      const msg = fmt.message(line);
      const msgTs = msg && stampTs(msg.stamp, day);
      if (msg && msgTs !== null) {
        acc.add(msgTs, msg.sender, msg.body, lineNo);
        cursor = msgTs;
        pendingBlank = 0;
        continue;
      }
      if (!msg) {
        const d = fmt.dateLine(line);
        if (d) {
          day = d;
          cursor = kstEpoch(d);
          pendingBlank = 0;
          continue;
        }
        const notice = fmt.notice(line);
        const known = notice && parseNotice(notice.text);
        const ts: number | null = notice && (notice.stamp ? stampTs(notice.stamp, day) : cursor);
        if (notice && known && ts !== null) {
          acc.add(ts, null, notice.text, lineNo, known.names);
          cursor = ts;
          pendingBlank = 0;
          continue;
        }
      }

      // 이어짐: 줄 머리 모양이 맞는데 여기까지 왔으면 해석 실패다
      const last = acc.messages[acc.messages.length - 1];
      if (!last || fmt.head.test(line)) acc.unrecognized++;
      if (last) {
        last.text += "\n".repeat(pendingBlank + 1) + line;
        acc.continuation++;
      }
      pendingBlank = 0;
    }
  }
}

function parseCsv(parts: FilePart[], acc: Accumulator): void {
  let lineOffset = 0;
  let cursor: number | null = null;
  for (const { lines, header } of parts) {
    const body = lines.slice(header).join("\n");
    for (const { fields, line } of readCsvRecords(body)) {
      acc.total++;
      const [date, user, message] = fields;
      const stamp = fields.length === 3 ? csvStamp(date) : undefined;
      const notice = parseNotice(message ?? "");
      // 날짜 칸이 빈 행은 시스템 문구일 때만 직전 시각으로 받는다
      const ts: number | null = stamp ? stampTs(stamp, null) : stamp === null && notice ? cursor : null;
      if (ts === null) {
        acc.unrecognized++;
        continue;
      }
      // mac은 시스템 문구도 발신자 칸에 사람 이름을 넣는다(zeikar mac.ts). 사전에 맞으면 시스템 메시지다
      acc.add(ts, notice ? null : user, message, lineOffset + header + line, notice?.names);
      cursor = ts;
    }
    lineOffset += lines.length;
  }
}
