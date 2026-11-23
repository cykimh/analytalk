// AI용 페이로드를 만들고 읽는다. 이름 정리(applyDisplayNames)를 거친 메시지만 받는다. DOM 없이 브라우저(Worker)·node 공용.
// 줄 형식(KST): 날짜가 바뀌면 `# YYYY-MM-DD`, 메시지는 `m<id>|MM-DD HH:mm|<표시이름>|<본문>`
import { ANCHOR_BUSY_DAYS, ANCHOR_FIRST_N } from "@/lib/config";
import type { ChatMessage, MsgKind } from "@/lib/parse/parse";
import { type ChatStats, computeStats } from "@/lib/stats/compute";
import { type MaskCounts, type MaskKind, maskPII } from "./mask";
import { isSensitive } from "./sensitive";

export interface Payload {
  v: 1;
  concept: "group" | "couple";
  kind: "pair" | "group" | "work";
  /** 업로더 본인의 표시 이름 */
  me: string;
  /** 발신자 표시 이름(처음 나온 순서) */
  members: string[];
  /** 첫·마지막 메시지의 KST 날짜 YYYY-MM-DD */
  period: { start: string; end: string };
  /** transcript 첫 메시지 시각(ISO +09:00). transcript가 비면 마지막 메시지 시각 */
  cutoffAt: string;
  /** 시스템 메시지를 뺀 전체 메시지 수 */
  msgTotal: number;
  /** transcript에 담은 메시지 수(anchors 제외) */
  msgSent: number;
  stats: ChatStats;
  /** 첫 메시지 ANCHOR_FIRST_N개 + 메시지 수 상위 ANCHOR_BUSY_DAYS일 중 transcript에 없는 것 */
  anchors: string;
  /** 마지막 메시지까지 이어지는 최근 구간 */
  transcript: string;
  /** anchors·transcript에서 가린 개수. 키: phone·email·account·rrn·url·sensitive */
  maskCounts: Record<string, number>;
}

const MESSAGE_LINE = /^m(\d+)\|(\d{2}-\d{2}) (\d{2}:\d{2})\|([^|\n]{1,20})\|(.*)$/u;
const DAY_HEADER = /^# (\d{4}-\d{2}-\d{2})$/;

export type BlockLine =
  | { type: "header"; date: string }
  /** header: 이 줄 앞의 가장 가까운 날짜 헤더(YYYY-MM-DD), 없으면 null */
  | { type: "message"; ref: string; id: number; mmdd: string; time: string; sender: string; body: string; header: string | null }
  | { type: "bad" };

/** anchors·transcript 한 덩어리를 줄 단위로 읽는다. 빈 문자열은 줄 0개 */
export function readBlock(block: string): BlockLine[] {
  if (block === "") return [];
  let header: string | null = null;
  return block.split("\n").map((line): BlockLine => {
    const h = DAY_HEADER.exec(line);
    if (h) {
      header = h[1];
      return { type: "header", date: h[1] };
    }
    const m = MESSAGE_LINE.exec(line);
    if (!m) return { type: "bad" };
    return { type: "message", ref: `m${m[1]}`, id: Number(m[1]), mmdd: m[2], time: m[3], sender: m[4], body: m[5], header };
  });
}

/** msg_id → 보낸 줄의 발신자·시각(날짜 헤더의 연도를 이어받은 ISO +09:00)·본문. validatePayload를 통과한 페이로드용 */
export function payloadIndex(p: Payload): Map<string, { sender: string; at: string; text: string }> {
  const index = new Map<string, { sender: string; at: string; text: string }>();
  for (const line of [...readBlock(p.anchors), ...readBlock(p.transcript)]) {
    if (line.type !== "message" || line.header === null) continue;
    const at = `${line.header.slice(0, 4)}-${line.mmdd}T${line.time}:00+09:00`;
    index.set(line.ref, { sender: line.sender, at, text: line.body });
  }
  return index;
}

const MEDIA: Record<Exclude<MsgKind, "text">, string> = {
  photo: "[사진]",
  video: "[동영상]",
  emoticon: "[이모티콘]",
  file: "[파일]",
  deleted: "[삭제된 메시지]",
  call: "[통화]",
  other: "[기타]",
  system: "[알림]",
};
const LINE_BREAK = /\r\n|[\r\n\p{Zl}\p{Zp}]/gu;
const MASK_KINDS: MaskKind[] = ["phone", "email", "account", "rrn", "url"];

const KST_OFFSET_MS = 9 * 3_600_000;
const pad = (n: number) => String(n).padStart(2, "0");

function kst(ts: number): { day: string; time: string; iso: string } {
  const d = new Date(ts + KST_OFFSET_MS);
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return { day, time, iso: `${day}T${time}:${pad(d.getUTCSeconds())}+09:00` };
}

type ChatLine = ChatMessage & { sender: string };
interface Rendered {
  day: string;
  line: string;
  masked: MaskCounts | null;
  sensitive: boolean;
}

/** 미디어는 표시로, 민감 주제는 [가림:민감]으로, 나머지는 줄바꿈·꺾쇠를 바꾼 뒤 개인정보를 가린다 */
function render(m: ChatLine): Rendered {
  const { day, time } = kst(m.ts);
  let body: string;
  let masked: MaskCounts | null = null;
  let sensitive = false;
  if (m.kind !== "text") body = MEDIA[m.kind];
  else if (isSensitive(m.text)) {
    body = "[가림:민감]";
    sensitive = true;
  } else {
    const r = maskPII(m.text.replace(LINE_BREAK, " ⏎ ").replace(/</g, "＜").replace(/>/g, "＞"));
    body = r.text;
    masked = r.counts;
  }
  return { day, line: `m${m.id}|${day.slice(5)} ${time}|${m.sender}|${body}`, masked, sensitive };
}

/** 날짜가 바뀔 때마다 헤더를 넣어 줄을 잇는다 */
function joinBlock(items: Rendered[]): string {
  const out: string[] = [];
  let day: string | null = null;
  for (const r of items) {
    if (r.day !== day) out.push(`# ${(day = r.day)}`);
    out.push(r.line);
  }
  return out.join("\n");
}

/**
 * 표시 이름으로 바뀐 메시지로 페이로드를 만든다. stats는 시스템 메시지를 뺀 전체 메시지로 계산한다.
 * tokenBudget은 transcript 몫이다(글자 수 × tokensPerChar, 줄바꿈과 날짜 헤더 포함).
 * stats·anchors·프롬프트 몫은 호출하는 쪽이 빼고 넘긴다.
 * 시스템 메시지를 뺀 메시지가 없으면 던진다.
 */
export function buildPayload(input: {
  messages: ChatMessage[];
  me: string;
  concept: Payload["concept"];
  kind: Payload["kind"];
  tokenBudget: number;
  tokensPerChar: number;
}): Payload {
  const { me, concept, kind, tokenBudget, tokensPerChar } = input;
  const chat = input.messages
    .filter((m): m is ChatLine => m.sender !== null && m.kind !== "system")
    .sort((a, b) => a.id - b.id);
  if (chat.length === 0) throw new Error("보낼 메시지가 없다");
  const stats = computeStats(chat);

  const cache = new Map<number, Rendered>();
  const rendered = (i: number): Rendered => {
    let r = cache.get(i);
    if (!r) cache.set(i, (r = render(chat[i])));
    return r;
  };

  // transcript: 마지막 메시지부터 거꾸로, 다음 줄이 예산을 넘기 직전까지. 날짜가 바뀌면 헤더 줄 몫도 센다
  const cost = (s: string) => (s.length + 1) * tokensPerChar;
  let start = chat.length;
  let used = 0;
  let day: string | null = null;
  for (let i = chat.length - 1; i >= 0; i--) {
    const r = rendered(i);
    const c = cost(r.line) + (r.day === day ? 0 : cost(`# ${r.day}`));
    if (used + c > tokenBudget) break;
    used += c;
    start = i;
    day = r.day;
  }

  // anchors: transcript(start 이후) 앞의 메시지 중 첫 N개와 메시지 수 상위 날짜(동률이면 이른 날짜)
  const busyDays = new Set(
    Object.entries(stats.dailyCounts)
      .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
      .slice(0, ANCHOR_BUSY_DAYS)
      .map(([d]) => d),
  );
  const anchorIdx: number[] = [];
  for (let i = 0; i < start; i++) if (i < ANCHOR_FIRST_N || busyDays.has(kst(chat[i].ts).day)) anchorIdx.push(i);
  const sentIdx = Array.from({ length: chat.length - start }, (_, k) => start + k);

  const maskCounts: Record<string, number> = { phone: 0, email: 0, account: 0, rrn: 0, url: 0, sensitive: 0 };
  for (const i of [...anchorIdx, ...sentIdx]) {
    const r = rendered(i);
    if (r.sensitive) maskCounts.sensitive++;
    if (r.masked) for (const k of MASK_KINDS) maskCounts[k] += r.masked[k];
  }

  // 메시지가 10만 개를 넘을 수 있어 Math.min(...배열) 대신 한 번 훑는다
  let first = chat[0].ts;
  let last = chat[0].ts;
  for (const m of chat) {
    if (m.ts < first) first = m.ts;
    if (m.ts > last) last = m.ts;
  }
  return {
    v: 1,
    concept,
    kind,
    me,
    members: [...new Set(chat.map((m) => m.sender))],
    period: { start: kst(first).day, end: kst(last).day },
    cutoffAt: kst(start < chat.length ? chat[start].ts : last).iso,
    msgTotal: stats.total,
    msgSent: sentIdx.length,
    stats,
    anchors: joinBlock(anchorIdx.map(rendered)),
    transcript: joinBlock(sentIdx.map(rendered)),
    maskCounts,
  };
}
