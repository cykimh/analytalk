// AI용 페이로드를 만들고 읽는다. 이름 정리(applyDisplayNames)를 거친 메시지만 받는다. DOM 없이 브라우저(Worker)·node 공용.
// 줄 형식(KST): 날짜가 바뀌면 `# YYYY-MM-DD`, 메시지는 `m<id>|HH:mm|<기호>|<본문>`. 기호(A, B, … AA)는 범례(legendText)로 표시 이름과 짝지어진다
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
import type { Tone } from "@/lib/llm/concepts";
import type { ChatMessage, MsgKind } from "@/lib/parse/parse";
import { type ChatStats, computeStats } from "@/lib/stats/compute";
import { statsForPrompt } from "@/lib/stats/view";
import { type MaskCounts, type MaskKind, maskPII } from "./mask";

export interface Payload {
  v: 2;
  concept: "group" | "couple";
  kind: "pair" | "group" | "work";
  /** 리포트 말투 */
  tone: Tone;
  /** 분석에 넣은 발신자 표시 이름(처음 나온 순서, 2명 이상). 줄 안의 기호는 이 순서의 memberCodes다 */
  members: string[];
  /** 첫·마지막 메시지의 KST 날짜 YYYY-MM-DD */
  period: { start: string; end: string };
  /** transcript 첫 메시지 시각(ISO +09:00). 고르게 고르면 보통 대화 첫 메시지 근처다 */
  cutoffAt: string;
  /** 시스템 메시지를 뺀 전체 메시지 수 */
  msgTotal: number;
  /** transcript에 담은 메시지 수(anchors 제외). 화면의 "전체 기간에서 N개" */
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
   * 가장 최근 메시지가 예산보다 길면 그 본문을 자른(끝에 …) 한 줄이다
   */
  transcript: string;
  /** anchors·transcript에서 가린 개수. 키: phone·email·account·rrn·url */
  maskCounts: Record<string, number>;
}

const MESSAGE_LINE = /^m(\d+)\|(\d{2}:\d{2})\|([A-Z]{1,3})\|(.*)$/u;
const DAY_HEADER = /^# (\d{4}-\d{2}-\d{2})$/;

/** message의 header는 이 줄 앞의 가장 가까운 날짜 헤더(YYYY-MM-DD)이고, 없으면 null이다 */
export type BlockLine =
  | { type: "header"; date: string }
  | { type: "message"; ref: string; id: number; time: string; code: string; body: string; header: string | null }
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
    return { type: "message", ref: `m${m[1]}`, id: Number(m[1]), time: m[2], code: m[3], body: m[4], header };
  });
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

/** msg_id → 보낸 줄의 발신자(표시 이름)·시각(날짜 헤더 + 줄의 시각, ISO +09:00)·본문. 범례에 없는 기호의 줄은 뺀다. validatePayload를 통과한 페이로드용 */
export function payloadIndex(p: Payload): Map<string, { sender: string; at: string; text: string }> {
  const codes = memberCodes(p.members);
  const index = new Map<string, { sender: string; at: string; text: string }>();
  for (const line of [...readBlock(p.anchors), ...readBlock(p.transcript)]) {
    if (line.type !== "message" || line.header === null) continue;
    const who = codes.indexOf(line.code);
    if (who < 0) continue;
    index.set(line.ref, { sender: p.members[who], at: `${line.header}T${line.time}:00+09:00`, text: line.body });
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
  /** 줄 머리 `m<id>|HH:mm|<기호>|`. line = head + 본문 */
  head: string;
  line: string;
  masked: MaskCounts | null;
}

/** 미디어는 표시로, 나머지는 줄바꿈·꺾쇠를 바꾼 뒤 개인정보를 가린다 */
function render(m: ChatLine, code: string): Rendered {
  const { day, time } = kst(m.ts);
  let body: string;
  let masked: MaskCounts | null = null;
  if (m.kind !== "text") body = MEDIA[m.kind];
  else {
    const r = maskPII(m.text.replace(LINE_BREAK, " ⏎ ").replace(/</g, "＜").replace(/>/g, "＞"));
    body = r.text;
    masked = r.counts;
  }
  const head = `m${m.id}|${time}|${code}|`;
  return { day, head, line: head + body, masked };
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
  tone: Tone;
  tokenBudget: number;
  tokensPerChar: number;
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
 * - 대화 전체가 tokenBudget에 들어가면 전부 보낸다
 * - 아니면 전체 기간에서 고른다(sampleRanges): 최근 구간, 가장 활발했던 날들, 달마다 고르게 띄운 연속 덩어리. 남은 몫은 최근 구간이 마저 쓴다
 * - 가장 최근 메시지 한 줄조차 tokenBudget보다 길면 그 본문을 잘라(끝에 …) 넣는다. transcript는 늘 1건 이상이다
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
  const rendered = chat.map((m) => render(m, codes.get(m.sender)!));

  // 예산은 글자 단위 정수로 센다(줄마다 글자 수 + 줄바꿈 1). 글자 × tokensPerChar ≤ tokenBudget이 되게 내림하고,
  // 소수점 오차로 넘치면 한 글자씩 줄인다
  let budget = Math.floor(tokenBudget / tokensPerChar);
  while (budget > 0 && budget * tokensPerChar > tokenBudget) budget--;
  const lineChars = (r: Rendered) => r.line.length + 1;

  // 가장 최근 메시지 한 줄(과 날짜 헤더)조차 예산보다 길면 본문을 잘라 둔다. 아래 고르기는 잘린 줄을 쓴다.
  // 본문 글자 수 n은 예산에서 헤더·줄 머리·…·줄바꿈을 뺀 값이다
  const lastIdx = chat.length - 1;
  const fitsAlone = (r: Rendered) => lineChars(r) + HEADER_CHARS <= budget;
  const newest = rendered[lastIdx];
  if (!fitsAlone(newest)) {
    let n = budget - HEADER_CHARS - 1 - newest.head.length - "…".length;
    while (n >= 0 && !fitsAlone(cutLine(newest, n))) n--;
    if (n < 0) throw new Error("예산이 모자라다: 날짜 헤더와 줄 머리조차 들어가지 않는다");
    rendered[lastIdx] = cutLine(newest, n);
  }

  const busyDays = Object.entries(stats.dailyCounts)
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
    .slice(0, SAMPLE_BUSY_DAYS)
    .map(([d]) => d);
  const ranges = sampleRanges(
    {
      chars: rendered.map(lineChars),
      days: rendered.map((r) => r.day),
      sessionStart: chat.map((m, i) => i === 0 || m.ts - chat[i - 1].ts >= SILENCE_GAP_MS),
      busyDays,
    },
    budget,
  );
  const sentIdx = ranges.flatMap(([a, b]) => Array.from({ length: b - a }, (_, k) => a + k));

  const maskCounts: Record<string, number> = { phone: 0, email: 0, account: 0, rrn: 0, url: 0 };
  for (const i of sentIdx) {
    const r = rendered[i];
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
    v: 2,
    concept,
    kind,
    tone,
    members,
    period: { start: kst(first).day, end: kst(last).day },
    cutoffAt: kst(chat[sentIdx[0]].ts).iso,
    msgTotal: stats.total,
    msgSent: sentIdx.length,
    stats,
    anchors: "",
    transcript: joinBlock(sentIdx.map((i) => rendered[i])),
    maskCounts,
  };
}

/** 날짜 헤더 한 줄 `# YYYY-MM-DD`(+ 줄바꿈)의 글자 수 */
const HEADER_CHARS = "# YYYY-MM-DD".length + 1;

interface SampleInput {
  /** 메시지마다 줄 글자 수 + 1(줄바꿈) */
  chars: number[];
  /** 메시지마다 KST 날짜 YYYY-MM-DD */
  days: string[];
  /** 메시지마다 대화가 시작하는 곳인가(첫 메시지이거나 앞 메시지와 SILENCE_GAP_MS 이상 떨어짐) */
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
 * 보낼 메시지 번호 구간 [a, b)들(시간순, 겹치거나 붙은 것은 합침). 구간을 이어 joinBlock한 덩어리는 budget 글자를 넘지 않는다.
 * 대화 전체가 들어가면 [[0, n)]. 아니면:
 * 1. 최근 구간: 마지막 메시지부터 거꾸로 budget × SAMPLE_TAIL_SHARE까지(마지막 메시지는 늘 넣는다)
 * 2. 가장 활발했던 날들: 그날 첫 메시지부터 이어서, budget × SAMPLE_BUSY_SHARE를 날짜끼리 공평하게
 * 3. 달마다: 남은 몫을 (최근 구간 앞의) 달끼리 공평하게 나누고, 달 몫은 달 안에 고르게 띄운 연속 덩어리
 *    SAMPLE_CHUNKS_PER_MONTH개 이하로 쓴다. 덩어리는 대화가 시작하는 곳에서 시작한다(없으면 그 자리에서)
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
      // 자리 안에서 대화가 시작하는 첫 곳. 없으면 자리 첫머리
      for (let i = start; i < slotEnd; i++) {
        if (sessionStart[i]) {
          start = i;
          break;
        }
      }
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
