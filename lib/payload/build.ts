// AI용 페이로드를 만들고 읽는다. 이름 정리(applyDisplayNames)를 거친 메시지만 받는다. DOM 없이 브라우저(Worker)·node 공용.
// 줄 형식(KST): 날짜가 바뀌면 `# YYYY-MM-DD`, 메시지는 `m<id>|HH:mm|<기호>|<본문>`. 기호(A, B, … AA)는 범례(legendText)로 표시 이름과 짝지어진다.
// v2.7(같은 예산으로 더 많이 읽기): 대화가 예산에 다 안 들어가면 줄을 줄인다(compactUnits).
//   1단계 묶기: 같은 사람이 같은 날 같은 분(HH:mm)에 번호가 이어지게 보낸 메시지를 한 줄로 묶는다. 머리는 `m<첫 id>+<k>`(k개 더, 모두 k + 1개),
//     본문은 메시지 사이를 BUNDLE_SEP(" ¦ ")로 잇는다. 같은 분이라 묶음의 글 메시지는 모두 머리의 시각이 제 시각이다(근거 카드의 시각이 맞다).
//     미디어(사진 등)와 짧은 반응(자모·기호뿐인 ㅋㅋ·ㅇㅇ·ㅠㅠ)이 같은 것끼리 이어지면 한 칸에 `[사진×3]`·`ㅋㅋ×2`로 접는다.
//   2단계 접기: 미디어·짧은 반응만 따로 보낸 것(같은 분 덩어리에 글이 없는 것)은 같은 사람의 바로 앞 줄 끝에 접고, 접을 곳이 없으면 뺀다.
//     마지막 메시지는 빼지 않는다. 짧은 반응은 ㅋ 개수가 달라도 같은 반응으로 접는다(ㅋㅋ·ㅋㅋㅋ → ㅋㅋ×2).
//   한 줄에 하나씩(예전 모양) → 1단계 → 2단계 순서로, 대화 전체가 처음 들어가는 단계를 쓰고 셋 다 안 들어가면 2단계에서 고른다(sampleRanges).
//   payloadIndex는 묶음을 메시지마다 풀어 제 번호·본문을 기억한다(접은 칸은 근거로 쓰지 않는다). msgSent는 줄이 덮는 원본 메시지 수다.
import {
  MAX_PAYLOAD_BYTES,
  PROMPT_RESERVE_TOKENS,
  SAMPLE_BUSY_DAYS,
  SAMPLE_BUSY_SHARE,
  SAMPLE_CHUNKS_PER_MONTH,
  SAMPLE_MIN_CHUNK_CHARS,
  SAMPLE_TAIL_SHARE,
  SILENCE_GAP_MS,
} from "@/lib/config";
import type { PickableTone } from "@/lib/llm/concepts";
import type { ChatMessage, MsgKind } from "@/lib/parse/parse";
import { type ChatStats, computeStats } from "@/lib/stats/compute";
import { statsForPrompt } from "@/lib/stats/view";
import { type MaskCounts, type MaskKind, maskPII } from "./mask";

export interface Payload {
  v: 2;
  concept: "group" | "couple";
  kind: "pair" | "group" | "work";
  /** 리포트 말투. 새 리포트는 고를 수 있는 말투(PICKABLE_TONES)만 쓴다(v2.3: record는 저장된 행에만 있다) */
  tone: PickableTone;
  /** 분석에 넣은 발신자 표시 이름(처음 나온 순서, 2명 이상). 줄 안의 기호는 이 순서의 memberCodes다 */
  members: string[];
  /** 첫·마지막 메시지의 KST 날짜 YYYY-MM-DD */
  period: { start: string; end: string };
  /** transcript 첫 메시지 시각(ISO +09:00). 고르게 고르면 보통 대화 첫 메시지 근처다 */
  cutoffAt: string;
  /** 시스템 메시지를 뺀 전체 메시지 수 */
  msgTotal: number;
  /** transcript에 담은 원본 메시지 수(anchors 제외, v2.7: 묶음·접은 칸이 덮는 메시지까지, 뺀 반응·미디어는 빼고). 화면의 "전체 기간에서 N개" */
  msgSent: number;
  /** 전체 통계. 서버의 자리표시자 해석이 쓴다. 모델에게는 statsForPrompt로 줄여 보낸다 */
  stats: ChatStats;
  /**
   * 예전 형식(v2.0)의 발췌: transcript보다 앞 시기의 첫 대화와 활발했던 날. 지금 만드는 페이로드에서는 늘 빈 문자열이다.
   * 이 브라우저에 둔 예전 사본으로 [다시 쓰기]를 할 수 있게 검증·프롬프트는 아직 받는다
   */
  anchors: string;
  /**
   * 보낸 메시지 전부(시간순). 대화 전체가 tokenBudget에 들어가면 전부이고, 아니면 처음부터 끝까지 전체 기간에서 고른 것이다:
   * 달마다 연속 덩어리, 가장 활발했던 날들, 마지막 메시지까지 이어지는 최근 구간(조금 더 많이). 1건 이상이고 늘 마지막 메시지로 끝난다.
   * v2.7: 한 줄에 하나씩으로 다 안 들어가면 묶고 접은 줄 모양(이 파일 머리 주석)을 쓴다. 마지막 줄은 늘 마지막 메시지를 덮는다.
   * 가장 최근 줄이 예산보다 길면 가장 최근 메시지 하나만, 그래도 길면 그 본문을 자른(끝에 …) 한 줄이다
   */
  transcript: string;
  /** anchors·transcript에서 가린 개수. 키: phone·email·account·rrn·url */
  maskCounts: Record<string, number>;
}

const MESSAGE_LINE = /^m(\d+)(?:\+([1-9]\d*))?\|(\d{2}:\d{2})\|([A-Z]{1,3})\|(.*)$/u;
const DAY_HEADER = /^# (\d{4}-\d{2}-\d{2})$/;

/**
 * message의 header는 이 줄 앞의 가장 가까운 날짜 헤더(YYYY-MM-DD)이고, 없으면 null이다.
 * more는 묶음 줄(`m<id>+<k>`)의 k다: 이 줄은 id부터 id + k까지 k + 1개 메시지를 덮는다. 한 메시지 줄은 0
 */
export type BlockLine =
  | { type: "header"; date: string }
  | { type: "message"; ref: string; id: number; more: number; time: string; code: string; body: string; header: string | null }
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
    return { type: "message", ref: `m${m[1]}`, id: Number(m[1]), more: m[2] ? Number(m[2]) : 0, time: m[3], code: m[4], body: m[5], header };
  });
}

/** 묶음 줄에서 메시지 사이 경계(v2.7). 묶음 안 글의 "¦"는 전각 "￤"로 바꿔 두어 경계는 늘 이것뿐이다 */
export const BUNDLE_SEP = " ¦ ";
/** 묶음 한 줄의 칸 수 상한(접은 칸 포함). 넘으면 다음 줄로 */
export const BUNDLE_MAX_PARTS = 10;
/** 묶음 한 줄의 본문 글자 수 상한. 칸을 더하면 넘을 때 다음 줄로(그보다 긴 메시지 하나는 혼자 한 줄) */
export const BUNDLE_MAX_CHARS = 300;
/** 짧은 반응의 글자 수 상한(공백·줄바꿈 표시 제외, 코드 포인트) */
export const REACTION_MAX_CHARS = 10;
/** 짧은 반응에 쓰는 글자: 한글 호환 자모(ㅋ·ㅎ·ㅠ·ㅇ·ㄷ·ㄱ…), 공백·줄바꿈 표시, 흔한 문장부호·기호, 그림 문자. 숫자·글자·×·¦는 없다 */
const REACTION_CHARS = /^[\u3131-\u318E\s!?.,~…^;:'"*\-_♡♥★☆♪♬·⏎\p{Extended_Pictographic}\u200D\uFE0E\uFE0F\u{1F3FB}-\u{1F3FF}]+$/u;

/** 본문(가린 뒤)이 짧은 반응인가: 자모·기호만이고 REACTION_MAX_CHARS자 이하 */
export function isReaction(body: string): boolean {
  const visible = body.replace(/[\s⏎]/gu, "");
  return visible !== "" && Array.from(visible).length <= REACTION_MAX_CHARS && REACTION_CHARS.test(body);
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
/** 묶음 칸 중 미디어: `[사진]` 또는 접은 `[사진×3]` */
const MEDIA_PART = new RegExp(`^\\[(${Object.values(MEDIA).map((m) => m.slice(1, -1)).join("|")})(?:×([1-9]\\d*))?\\]$`, "u");
/** 묶음 칸 중 접은 짧은 반응: `ㅋㅋ×5` */
const REACTION_RUN = /^(.+)×([1-9]\d*)$/u;

/** 묶음 줄의 한 칸이 미디어·짧은 반응이면 그 칸이 덮는 메시지 수(×n이면 n, 아니면 1), 글이면 null */
export function foldedCount(part: string): number | null {
  const media = MEDIA_PART.exec(part);
  if (media) return media[2] ? Number(media[2]) : 1;
  const run = REACTION_RUN.exec(part);
  if (run && isReaction(run[1])) return Number(run[2]);
  return isReaction(part) ? 1 : null;
}

/** 묶음 줄 본문이 덮는 메시지 수(칸마다 foldedCount, 글 칸은 1) */
export function bundleSize(body: string): number {
  return body.split(BUNDLE_SEP).reduce((n, part) => n + (foldedCount(part) ?? 1), 0);
}

/**
 * members 순서대로 A…Z, AA…(엑셀 열 방식)인 기호. 어떤 멤버의 표시 이름과 같은 기호(대소문자 무시)는 건너뛴다
 * (줄 안의 기호와 이름이 헷갈리지 않게)
 */
export function memberCodes(members: string[]): string[] {
  const taken = new Set(members.map((n) => n.toUpperCase()));
  const codes: string[] = [];
  let n = 0;
  while (codes.length < members.length) {
    n++;
    let code = "";
    for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) code = String.fromCharCode(65 + ((k - 1) % 26)) + code;
    if (!taken.has(code)) codes.push(code);
  }
  return codes;
}

/** 한 줄에 `기호=표시 이름`, members 순서, "\n"으로 잇는다 */
export function legendText(members: string[]): string {
  const codes = memberCodes(members);
  return members.map((name, i) => `${codes[i]}=${name}`).join("\n");
}

/** 보낸 메시지 하나. lineRef는 묶음 줄(v2.7)에서 온 메시지에만 있고, 그 줄 머리의 m번호다(같은 줄 메시지끼리 같다) */
export type IndexEntry = { sender: string; at: string; text: string; lineRef?: string };

/**
 * msg_id → 보낸 메시지의 발신자(표시 이름)·시각(날짜 헤더 + 줄의 시각, ISO +09:00)·본문. 범례에 없는 기호의 줄은 뺀다. validatePayload를 통과한 페이로드용.
 * v2.7 묶음 줄은 칸마다 풀어 글 메시지마다 제 번호(머리 번호 + 앞 칸들이 덮는 수)와 본문을 둔다. 시각은 머리의 것이다(묶음의 글은 같은 분).
 * 접은 미디어·짧은 반응 칸은 넣지 않는다(인용할 말이 아니고, 앞 줄에 접은 것은 시각도 다르다)
 */
export function payloadIndex(p: Payload): Map<string, IndexEntry> {
  const codes = memberCodes(p.members);
  const index = new Map<string, IndexEntry>();
  for (const line of [...readBlock(p.anchors), ...readBlock(p.transcript)]) {
    if (line.type !== "message" || line.header === null) continue;
    const who = codes.indexOf(line.code);
    if (who < 0) continue;
    const sender = p.members[who];
    const at = `${line.header}T${line.time}:00+09:00`;
    if (line.more === 0) {
      index.set(line.ref, { sender, at, text: line.body });
      continue;
    }
    let id = line.id;
    for (const part of line.body.split(BUNDLE_SEP)) {
      const n = foldedCount(part);
      if (n === null) index.set(`m${id}`, { sender, at, text: part, lineRef: line.ref });
      id += n ?? 1;
    }
  }
  return index;
}

/** 덩어리 하나의 추정 토큰. 줄마다 (글자 수 + 1) × tokensPerChar이므로 (전체 글자 수 + 1) × tokensPerChar, 빈 덩어리는 0 */
const blockTokens = (block: string, tokensPerChar: number) => (block === "" ? 0 : (block.length + 1) * tokensPerChar);

/** 모델에게 보이는 stats(statsForPrompt)의 추정 토큰. JSON 글자 수로 어림한다 */
const promptStatsTokens = (stats: ChatStats, tokensPerChar: number) =>
  JSON.stringify(statsForPrompt(stats)).length * tokensPerChar;

/**
 * 페이로드의 추정 토큰(글자 수 × tokensPerChar).
 * - text: anchors + transcript. buildPayload가 tokenBudget 안으로 맞추는 몫이다(새 페이로드의 anchors는 비어 있다)
 * - total: text + 모델에게 보이는 stats(statsForPrompt) + 범례(legendText). system 프롬프트와 지시는 들어 있지 않다
 */
export function payloadTokens(
  p: Pick<Payload, "stats" | "anchors" | "transcript" | "members">,
  tokensPerChar: number,
): { text: number; total: number } {
  const text = blockTokens(p.anchors, tokensPerChar) + blockTokens(p.transcript, tokensPerChar);
  return { text, total: text + promptStatsTokens(p.stats, tokensPerChar) + blockTokens(legendText(p.members), tokensPerChar) };
}

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
  /** 줄 머리 `m<id>|HH:mm|<기호>|`(묶음이면 `m<id>+<k>|…`). line = head + 본문 */
  head: string;
  line: string;
  /** 이 줄이 덮는 메시지의 가린 개수 합 */
  masked: MaskCounts;
  /** 이 줄이 덮는 첫 메시지의 chat 자리와 덮는 메시지 수(chat에서 이어진 자리, 번호도 1씩 이어진다) */
  from: number;
  count: number;
}

/** 메시지 하나의 본문: 미디어는 표시로, 글은 줄바꿈·꺾쇠를 바꾼 뒤 개인정보를 가린다. 가린 글이 짧은 반응이면 reaction */
interface Piece {
  kind: "text" | "media" | "reaction";
  body: string;
  masked: MaskCounts | null;
}
function piece(m: ChatLine): Piece {
  if (m.kind !== "text") return { kind: "media", body: MEDIA[m.kind], masked: null };
  const r = maskPII(m.text.replace(LINE_BREAK, " ⏎ ").replace(/</g, "＜").replace(/>/g, "＞"));
  return { kind: isReaction(r.text) ? "reaction" : "text", body: r.text, masked: r.counts };
}

/** 줄 모양 단계(v2.7): 한 줄에 하나씩(예전 모양) → 1단계 묶기 → 2단계 접기 */
type LineStyle = "plain" | "bundle" | "compact";

/** 줄 하나의 칸. n은 그 칸이 덮는 메시지 수(접은 미디어·반응만 2 이상), key는 접을 때 같은 것으로 보는 값, text는 묶음 줄에 쓰는 글(partText) */
interface Part {
  kind: Piece["kind"];
  body: string;
  n: number;
  key: string;
  text: string;
}
/** 줄 하나: chat의 [from, to) 자리 메시지를 덮는다 */
interface Unit {
  from: number;
  to: number;
  parts: Part[];
  /** 본문 글자 수(칸 글자 + 구분자). 한 메시지 줄의 본문(바꾸지 않은 글)과 글자 수가 같다: 바꾸는 글자는 모두 한 칸이다 */
  chars: number;
  masked: MaskCounts;
}

/**
 * 묶음 칸의 글. 글 칸은 "¦"를 전각 "￤"로 바꾸고, 접은 칸으로 읽히는 모양(`ㅋㅋ×5`·`[사진×3]`)이면 ×를 x로 바꾼다(칸 수가 어긋나지 않게).
 * 접은 칸은 n이 2 이상이면 ×n을 붙인다
 */
function partText(p: Pick<Part, "kind" | "body" | "n">): string {
  if (p.kind === "text") {
    if (!p.body.includes("¦") && !p.body.includes("×")) return p.body;
    const out = p.body.replaceAll("¦", "￤");
    return (foldedCount(out) ?? 1) > 1 ? out.replace(/×(?=[1-9]\d*\]?$)/u, "x") : out;
  }
  if (p.n === 1) return p.body;
  return p.kind === "media" ? `${p.body.slice(0, -1)}×${p.n}]` : `${p.body}×${p.n}`;
}

/** 짧은 반응을 같은 반응으로 볼 값: 공백·줄바꿈 표시를 지우고 이어진 같은 글자를 하나로(ㅋㅋㅋ → ㅋ) */
const reactionKey = (body: string) =>
  Array.from(body.replace(/[\s⏎]/gu, ""))
    .filter((c, k, all) => k === 0 || c !== all[k - 1])
    .join("");

type Stamp = ReturnType<typeof kst>;

/**
 * 줄 모양 단계(style)에 따라 chat을 줄(Unit)로 나눈다. plain은 메시지마다 한 줄이다.
 * bundle·compact는 같은 분 덩어리(같은 사람, 번호가 1씩 이어지고, 같은 날 같은 HH:mm)를 BUNDLE_MAX_PARTS칸·BUNDLE_MAX_CHARS자까지 한 줄로 묶는다.
 * 같은 미디어끼리, 같은 반응끼리(bundle은 글자까지 같을 때, compact는 reactionKey가 같을 때) 이어지면 한 칸에 접는다(상한과 상관없이).
 * compact는 글 없는 덩어리(미디어·반응뿐)를 같은 사람의 바로 앞 줄(번호가 이어지고 같은 날)에 접고, 접을 곳이 없으면 뺀다.
 * 마지막 메시지가 든 덩어리는 빼지 않는다
 */
function compactUnits(chat: ChatLine[], pieces: Piece[], stamp: Stamp[], style: LineStyle): Unit[] {
  const n = chat.length;
  const keyOf = (p: Piece) => (p.kind === "reaction" && style === "compact" ? reactionKey(p.body) : p.body);
  const partOf = (i: number): Part => {
    const p = pieces[i];
    return { kind: p.kind, body: p.body, n: 1, key: p.kind === "text" ? "" : keyOf(p), text: partText({ kind: p.kind, body: p.body, n: 1 }) };
  };
  const unitOf = (i: number): Unit => {
    const part = partOf(i);
    const m = pieces[i].masked;
    const masked: MaskCounts = m ? { ...m } : { phone: 0, email: 0, account: 0, rrn: 0, url: 0 };
    return { from: i, to: i + 1, parts: [part], chars: part.text.length, masked };
  };
  if (style === "plain") return chat.map((_, i) => unitOf(i));

  /** i번째 메시지를 u 끝에 붙인다(u는 i - 1번째까지 덮는다). 같은 것끼리면 마지막 칸에 접고, 아니면 상한 안에서만 새 칸 */
  const add = (u: Unit, i: number): boolean => {
    const p = pieces[i];
    const last = u.parts[u.parts.length - 1];
    if (p.kind !== "text" && last.kind === p.kind && last.key === keyOf(p)) {
      last.n++;
      u.chars -= last.text.length;
      last.text = partText(last);
      u.chars += last.text.length;
    } else {
      const part = partOf(i);
      if (u.parts.length >= BUNDLE_MAX_PARTS || u.chars + BUNDLE_SEP.length + part.text.length > BUNDLE_MAX_CHARS) return false;
      u.parts.push(part);
      u.chars += BUNDLE_SEP.length + part.text.length;
    }
    if (p.masked) for (const k of MASK_KINDS) u.masked[k] += p.masked[k];
    u.to = i + 1;
    return true;
  };
  /** i번째가 앞 메시지와 같은 사람이고 번호가 이어지고 같은 날이다 */
  const follows = (i: number) =>
    i > 0 && chat[i].sender === chat[i - 1].sender && chat[i].id === chat[i - 1].id + 1 && stamp[i].day === stamp[i - 1].day;

  const out: Unit[] = [];
  const pushRun = (a: number, b: number) => {
    let u: Unit | null = null;
    for (let i = a; i < b; i++) {
      if (u && add(u, i)) continue;
      u = unitOf(i);
      out.push(u);
    }
  };
  for (let a = 0; a < n; ) {
    let b = a + 1;
    let textless = pieces[a].kind !== "text";
    while (b < n && follows(b) && stamp[b].time === stamp[a].time) {
      if (pieces[b].kind === "text") textless = false;
      b++;
    }
    if (style !== "compact" || !textless) pushRun(a, b);
    else {
      // 미디어·반응뿐인 덩어리: 같은 사람의 바로 앞 줄 끝에 접는다. 못 접은 나머지는 빼되, 마지막 메시지가 들었으면 따로 한 줄로 둔다
      const target = out.at(-1);
      let i = a;
      if (target && target.to === a && follows(a)) while (i < b && add(target, i)) i++;
      if (i < b && b === n) pushRun(i, b);
    }
    a = b;
  }
  return out;
}

/** 줄 머리 `m<id>[+<k>]|HH:mm|<기호>|` */
const headOf = (u: Unit, chat: ChatLine[], stamp: Stamp[], codes: Map<string, string>) =>
  `m${chat[u.from].id}${u.to - u.from > 1 ? `+${u.to - u.from - 1}` : ""}|${stamp[u.from].time}|${codes.get(chat[u.from].sender)!}|`;

/** 줄 전부를 joinBlock했을 때의 글자 수(줄마다 머리 + 본문 + 줄바꿈, 날짜가 바뀔 때마다 헤더). 줄 글을 만들지 않고 센다 */
function unitsCost(units: Unit[], chat: ChatLine[], stamp: Stamp[], codes: Map<string, string>): number {
  let sum = 0;
  units.forEach((u, k) => {
    const more = u.to - u.from - 1;
    const head = 1 + String(chat[u.from].id).length + (more > 0 ? 1 + String(more).length : 0) + 7 + codes.get(chat[u.from].sender)!.length + 1;
    sum += head + u.chars + 1;
    if (k === 0 || stamp[units[k - 1].from].day !== stamp[u.from].day) sum += HEADER_CHARS;
  });
  return sum;
}

/** 줄(Unit) → 줄 글. 한 메시지 줄은 예전 모양 그대로(본문을 바꾸지 않는다) */
function renderUnit(u: Unit, chat: ChatLine[], stamp: Stamp[], codes: Map<string, string>): Rendered {
  const head = headOf(u, chat, stamp, codes);
  const count = u.to - u.from;
  const body = count === 1 ? u.parts[0].body : u.parts.map((p) => p.text).join(BUNDLE_SEP);
  return { day: stamp[u.from].day, head, line: head + body, masked: u.masked, from: u.from, count };
}

// 자른 본문 끝에서 뗄 글자. 가리기 규칙(링크·이메일·숫자 묶음)의 머리와 끝이 이 글자들이라, 이것들을 떼면
// 잘린 앞부분은 가리기를 다시 해도 바뀌지 않고 뒤에 …를 붙여도 새로 가릴 것이 생기지 않는다(validatePayload의 가리기 누락 검사)
const CUT_TAIL = /[\w.+\-@:/]+$/;

/**
 * 가린 뒤의 본문 앞 n글자(UTF-16)에서 CUT_TAIL을 떼고 …를 붙인 줄. 서로게이트 쌍은 가르지 않는다.
 * 가린 개수(masked)는 자르기 전 그대로 둔다
 */
function cutLine(r: Rendered, n: number): Rendered {
  let body = r.line.slice(r.head.length, r.head.length + n);
  if (/[\uD800-\uDBFF]$/.test(body)) body = body.slice(0, -1);
  return { ...r, line: `${r.head}${body.replace(CUT_TAIL, "")}…` };
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

export type BuildInput = {
  messages: ChatMessage[];
  concept: Payload["concept"];
  kind: Payload["kind"];
  tone: PickableTone;
  tokenBudget: number;
  tokensPerChar: number;
  /** false면 예산이 모자라도 묶거나 접지 않는다(v2.6까지의 줄 모양, 측정·비교용). 기본은 묶고 접는다 */
  compact?: boolean;
};

/** buildPayloadForBudget이 anchors + transcript에 남겨야 하는 최소 몫 */
const MIN_TEXT_BUDGET = 1000;

/** 시스템 메시지를 뺀 메시지(id 순서). 없으면 던진다 */
function chatLines(messages: ChatMessage[]): ChatLine[] {
  const chat = messages.filter((m): m is ChatLine => m.sender !== null && m.kind !== "system").sort((a, b) => a.id - b.id);
  if (chat.length === 0) throw new Error("보낼 메시지가 없다");
  return chat;
}

/**
 * 표시 이름으로 바뀐 메시지로 페이로드를 만든다. stats는 시스템 메시지를 뺀 전체 메시지로 계산한다.
 * tokenBudget은 transcript 몫이다(payloadTokens(p).text ≤ tokenBudget, 줄바꿈과 날짜 헤더 포함). anchors는 늘 비어 있다.
 * stats·system 프롬프트 몫은 호출하는 쪽이 빼고 넘긴다(buildPayloadForBudget). 예산을 줄여 다시 만들면 이 몫도 그만큼 줄어든다.
 * - 대화 전체가 tokenBudget에 들어가면 전부 보낸다. v2.7: 한 줄에 하나씩(예전 모양) → 1단계 묶기 → 2단계 접기 중 처음 들어가는 모양으로
 *   (compact: false면 예전 모양만)
 * - 아니면 2단계 모양(compact: false면 예전 모양)의 줄에서 전체 기간에서 고른다(sampleRanges): 최근 구간, 가장 활발했던 날들,
 *   달마다 고르게 띄운 연속 덩어리. 남은 몫은 최근 구간이 마저 쓴다
 * - 가장 최근 줄조차 tokenBudget보다 길면 가장 최근 메시지 하나만 넣고, 그래도 길면 그 본문을 잘라(끝에 …) 넣는다. transcript는 늘 1건 이상이다
 * 시스템 메시지를 뺀 메시지가 없거나, 잘라도 날짜 헤더와 줄 머리조차 안 들어가는 tokenBudget이면 던진다.
 */
export function buildPayload(input: BuildInput): Payload {
  const chat = chatLines(input.messages);
  return assemble(chat, computeStats(chat), input);
}

/**
 * 입력 예산 전체(inputBudget)에서 PROMPT_RESERVE_TOKENS·모델에게 보이는 stats(statsForPrompt)·범례 몫을 빼고,
 * 남은 몫을 tokenBudget으로 buildPayload와 같이 만든다(stats는 한 번만 센다). 페이로드 JSON이 MAX_PAYLOAD_BYTES의 90%를
 * 넘지 않게 글자 수도 제한한다(글자당 최대 3바이트로 어림). 남은 몫이 1,000 미만이면 던진다
 */
export function buildPayloadForBudget(input: Omit<BuildInput, "tokenBudget"> & { inputBudget: number }): Payload {
  const { inputBudget, ...rest } = input;
  const chat = chatLines(rest.messages);
  const stats = computeStats(chat);
  const { tokensPerChar } = rest;
  const legend = blockTokens(legendText([...new Set(chat.map((m) => m.sender))]), tokensPerChar);
  const byInput = inputBudget - PROMPT_RESERVE_TOKENS - promptStatsTokens(stats, tokensPerChar) - legend;
  const statsBytes = new TextEncoder().encode(JSON.stringify(stats)).length;
  const byBytes = Math.floor((MAX_PAYLOAD_BYTES * 0.9 - statsBytes) / 3) * tokensPerChar;
  const tokenBudget = Math.min(byInput, byBytes);
  if (tokenBudget < MIN_TEXT_BUDGET) throw new Error("입력 예산이 모자라다: 통계·범례·프롬프트 몫을 빼면 대화에 쓸 몫이 1,000 미만이다");
  return assemble(chat, stats, { ...rest, tokenBudget });
}

function assemble(chat: ChatLine[], stats: ChatStats, input: BuildInput): Payload {
  const { concept, kind, tone, tokenBudget, tokensPerChar } = input;
  const members = [...new Set(chat.map((m) => m.sender))];
  const codes = new Map(memberCodes(members).map((c, i) => [members[i], c]));
  const pieces = chat.map(piece);

  // 예산은 글자 단위 정수로 센다(줄마다 글자 수 + 줄바꿈 1). 글자 × tokensPerChar ≤ tokenBudget이 되게 내림하고,
  // 소수점 오차로 넘치면 한 글자씩 줄인다
  let budget = Math.floor(tokenBudget / tokensPerChar);
  while (budget > 0 && budget * tokensPerChar > tokenBudget) budget--;
  const lineChars = (r: Rendered) => r.line.length + 1;
  const stamp = chat.map((m) => kst(m.ts));

  // v2.7: 대화 전체가 처음 들어가는 줄 모양을 쓴다. 셋 다 안 들어가면 가장 짧은 모양(compact)에서 고른다
  const styles: LineStyle[] = input.compact === false ? ["plain"] : ["plain", "bundle", "compact"];
  let units: Unit[] = [];
  for (const style of styles) {
    units = compactUnits(chat, pieces, stamp, style);
    if (unitsCost(units, chat, stamp, codes) <= budget) break;
  }
  const rendered = units.map((u) => renderUnit(u, chat, stamp, codes));

  // 가장 최근 줄(과 날짜 헤더)조차 예산보다 길면 가장 최근 메시지 하나만 한 줄로 두고, 그래도 길면 본문을 잘라 둔다.
  // 아래 고르기는 그 줄을 쓴다. 본문 글자 수 n은 예산에서 헤더·줄 머리·…·줄바꿈을 뺀 값이다
  const lastIdx = rendered.length - 1;
  const fitsAlone = (r: Rendered) => lineChars(r) + HEADER_CHARS <= budget;
  if (!fitsAlone(rendered[lastIdx])) {
    const newestAt = chat.length - 1;
    const masked = pieces[newestAt].masked ?? { phone: 0, email: 0, account: 0, rrn: 0, url: 0 };
    const only: Part = { kind: pieces[newestAt].kind, body: pieces[newestAt].body, n: 1, key: "", text: pieces[newestAt].body };
    const alone = renderUnit({ from: newestAt, to: chat.length, parts: [only], chars: only.text.length, masked }, chat, stamp, codes);
    if (fitsAlone(alone)) rendered[lastIdx] = alone;
    else {
      let n = budget - HEADER_CHARS - 1 - alone.head.length - "…".length;
      while (n >= 0 && !fitsAlone(cutLine(alone, n))) n--;
      if (n < 0) throw new Error("예산이 모자라다: 날짜 헤더와 줄 머리조차 들어가지 않는다");
      rendered[lastIdx] = cutLine(alone, n);
    }
  }

  const busyDays = Object.entries(stats.dailyCounts)
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
    .slice(0, SAMPLE_BUSY_DAYS)
    .map(([d]) => d);
  const ranges = sampleRanges(
    {
      chars: rendered.map(lineChars),
      days: rendered.map((r) => r.day),
      // 줄이 덮는 첫 메시지가 앞 메시지(뺀 반응·미디어 포함)와 SILENCE_GAP_MS 이상 떨어졌으면 대화가 시작하는 곳이다
      sessionStart: rendered.map((r) => r.from === 0 || chat[r.from].ts - chat[r.from - 1].ts >= SILENCE_GAP_MS),
      busyDays,
    },
    budget,
  );
  const sent = ranges.flatMap(([a, b]) => rendered.slice(a, b));

  const maskCounts: Record<string, number> = { phone: 0, email: 0, account: 0, rrn: 0, url: 0 };
  for (const r of sent) for (const k of MASK_KINDS) maskCounts[k] += r.masked[k];

  // 메시지가 10만 개를 넘을 수 있어 Math.min(...배열) 대신 한 번 훑는다
  let first = chat[0].ts;
  let last = chat[0].ts;
  for (const m of chat) {
    if (m.ts < first) first = m.ts;
    if (m.ts > last) last = m.ts;
  }
  return {
    v: 2,
    concept,
    kind,
    tone,
    members,
    period: { start: kst(first).day, end: kst(last).day },
    cutoffAt: kst(chat[sent[0].from].ts).iso,
    msgTotal: stats.total,
    msgSent: sent.reduce((n, r) => n + r.count, 0),
    stats,
    anchors: "",
    transcript: joinBlock(sent),
    maskCounts,
  };
}

/** 날짜 헤더 한 줄 `# YYYY-MM-DD`(+ 줄바꿈)의 글자 수 */
const HEADER_CHARS = "# YYYY-MM-DD".length + 1;

/** 고르는 단위는 줄이다(v2.7: 묶음 줄은 메시지 여러 개). 아래 "메시지"는 그 줄이다 */
interface SampleInput {
  /** 메시지(줄)마다 줄 글자 수 + 1(줄바꿈) */
  chars: number[];
  /** 메시지(줄)마다 KST 날짜 YYYY-MM-DD */
  days: string[];
  /** 메시지(줄)마다 대화가 시작하는 곳인가(첫 메시지이거나 앞 메시지와 SILENCE_GAP_MS 이상 떨어짐) */
  sessionStart: boolean[];
  /** 메시지가 가장 많은 날들(많은 순) */
  busyDays: string[];
}

/** 몫을 공평하게 나눈다: 적게 필요한 쪽부터 다 주고, 남은 몫은 나머지가 똑같이 나눠 갖는다. 정수로 내린다 */
function fairShares(need: number[], total: number): number[] {
  const share = need.map(() => 0);
  let left = Math.max(0, total);
  [...need.keys()]
    .sort((a, b) => need[a] - need[b])
    .forEach((k, j, order) => {
      share[k] = Math.min(need[k], Math.floor(left / (order.length - j)));
      left -= share[k];
    });
  return share;
}

/**
 * 보낼 줄 번호 구간 [a, b)들(시간순, 겹치거나 붙은 것은 합침). 구간을 이어 joinBlock한 덩어리는 budget 글자를 넘지 않는다.
 * 대화 전체가 들어가면 [[0, n)]. 아니면:
 * 1. 최근 구간: 마지막 메시지부터 거꾸로 budget × SAMPLE_TAIL_SHARE까지(마지막 메시지는 늘 넣는다)
 * 2. 가장 활발했던 날들: 그날 첫 메시지부터 이어서, budget × SAMPLE_BUSY_SHARE를 날짜끼리 공평하게
 * 3. 달마다: 남은 몫을 (최근 구간 앞의) 달끼리 공평하게 나누고, 달 몫은 달 안에 고르게 띄운 연속 덩어리
 *    SAMPLE_CHUNKS_PER_MONTH개 이하로 쓴다. 덩어리는 대화가 시작하는 곳에서 시작한다(없으면 그 자리에서).
 *    시작 줄 하나가 덩어리 몫보다 길면 몫에 들어가는 다음 줄(달 안)에서 시작한다
 * 4. 합치고 남은 몫(겹침·자투리)으로 최근 구간을 더 거꾸로 늘린다
 * 구간마다 따로 센 비용(날짜 헤더 포함)의 합은 합친 덩어리의 비용 이상이라, 몫의 합이 budget 이하면 합친 덩어리도 budget 이하다
 * (합친 덩어리의 헤더는 이웃한 두 줄의 날짜가 다를 때나 구간 첫머리에만 생기고, 그 자리는 어느 구간에서든 이미 헤더로 셌다)
 */
function sampleRanges({ chars, days, sessionStart, busyDays }: SampleInput, budget: number): [number, number][] {
  const n = chars.length;
  // pre[i] = chars[0..i) 합, change[i] = 1..i 중 앞 줄과 날짜가 다른 줄 수
  const pre = new Array<number>(n + 1).fill(0);
  const change = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    pre[i + 1] = pre[i] + chars[i];
    if (i > 0) change[i] = change[i - 1] + (days[i] !== days[i - 1] ? 1 : 0);
  }
  /** [a, b)만 joinBlock했을 때의 글자 수 */
  const cost = (a: number, b: number) => (a >= b ? 0 : pre[b] - pre[a] + HEADER_CHARS * (1 + change[b - 1] - change[a]));
  /** a부터 앞으로 늘려 cap 안에 드는 가장 먼 끝(lim 이하). 비용은 b에 대해 커지기만 해서 이분 탐색한다 */
  const growForward = (a: number, lim: number, cap: number) => {
    let lo = a;
    let hi = lim;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (cost(a, mid) <= cap) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  if (cost(0, n) <= budget) return [[0, n]];

  // 1. 최근 구간 [tail, n)
  const tailCap = Math.max(Math.floor(budget * SAMPLE_TAIL_SHARE), cost(n - 1, n));
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (cost(mid, n) <= tailCap) hi = mid;
    else lo = mid + 1;
  }
  const tail = lo;
  const picked: [number, number][] = [[tail, n]];
  let left = budget - cost(tail, n);

  // 2. 가장 활발했던 날들. 날짜가 이어진 구간(최근 구간 앞까지)마다 앞에서부터
  const dayRange = (d: string): [number, number] | null => {
    const a = days.indexOf(d);
    if (a < 0 || a >= tail) return null;
    let b = a;
    while (b < tail && days[b] === d) b++;
    return [a, b];
  };
  const busy = busyDays.map(dayRange).filter((r): r is [number, number] => r !== null);
  const busyShares = fairShares(
    busy.map(([a, b]) => cost(a, b)),
    Math.min(Math.floor(budget * SAMPLE_BUSY_SHARE), left),
  );
  busy.forEach(([a, b], k) => {
    const end = growForward(a, b, busyShares[k]);
    if (end > a) {
      picked.push([a, end]);
      left -= cost(a, end);
    }
  });

  // 3. 달마다(최근 구간 앞). 날짜가 앞뒤로 섞인 대화도 있어 같은 달이 이어진 구간마다 한 몫이다
  const months: [number, number][] = [];
  for (let i = 0; i < tail; i++) {
    const last = months.at(-1);
    if (last && days[i].slice(0, 7) === days[last[1] - 1].slice(0, 7)) last[1] = i + 1;
    else months.push([i, i + 1]);
  }
  const monthShares = fairShares(
    months.map(([a, b]) => cost(a, b)),
    left,
  );
  months.forEach(([a, b], k) => {
    const share = monthShares[k];
    if (share >= cost(a, b)) {
      picked.push([a, b]);
      return;
    }
    const chunks = Math.max(1, Math.min(SAMPLE_CHUNKS_PER_MONTH, Math.floor(share / SAMPLE_MIN_CHUNK_CHARS)));
    const each = Math.floor(share / chunks);
    let prevEnd = a;
    for (let j = 0; j < chunks; j++) {
      const slotEnd = a + Math.floor(((j + 1) * (b - a)) / chunks);
      let start = Math.max(a + Math.floor((j * (b - a)) / chunks), prevEnd);
      if (start >= b) break;
      // 자리 안에서 대화가 시작하는 첫 곳(그 줄이 덩어리 몫에 들어갈 때만). 없으면 자리 첫머리.
      // 고른 줄 하나조차 몫보다 길면(붙여 넣은 긴 공지 등) 달 끝까지 몫에 들어가는 다음 줄로 옮긴다. 안 그러면 덩어리가 통째로 빈다
      const fits = (i: number) => cost(i, i + 1) <= each;
      for (let i = start; i < slotEnd; i++) {
        if (sessionStart[i] && fits(i)) {
          start = i;
          break;
        }
      }
      while (start < b && !fits(start)) start++;
      if (start >= b) break;
      const end = growForward(start, b, each);
      if (end > start) {
        picked.push([start, end]);
        prevEnd = end;
      }
    }
  });

  // 합친다(겹치거나 붙은 구간)
  picked.sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const [a, b] of picked) {
    const last = merged.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  // 합친 덩어리의 실제 글자 수: 구간마다의 비용에서, 앞 구간 끝과 날짜가 같아 생략되는 헤더를 뺀다
  const headerAt = (i: number, prev: number | null) => (prev === null || days[prev] !== days[i] ? HEADER_CHARS : 0);
  let used = 0;
  merged.forEach(([a, b], k) => {
    used += cost(a, b) - HEADER_CHARS + headerAt(a, k > 0 ? merged[k - 1][1] - 1 : null);
  });

  // 4. 남은 몫으로 최근 구간을 거꾸로 늘린다. 앞 구간에 닿으면 합친다
  const last = merged[merged.length - 1];
  while (last[0] > 0) {
    const i = last[0] - 1;
    const prevRange = merged.length > 1 ? merged[merged.length - 2] : null;
    const p = prevRange ? prevRange[1] - 1 : null;
    const delta = chars[i] + headerAt(i, p) + headerAt(last[0], i) - headerAt(last[0], p);
    if (used + delta > budget) break;
    used += delta;
    last[0] = i;
    if (prevRange && prevRange[1] === i) {
      last[0] = prevRange[0];
      merged.splice(merged.length - 2, 1);
    }
  }
  return merged;
}
