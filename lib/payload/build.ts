// AI용 페이로드를 만들고 읽는다. 이름 정리(applyDisplayNames)를 거친 메시지만 받는다. DOM 없이 브라우저(Worker)·node 공용.
// 줄 형식(KST): 날짜가 바뀌면 `# YYYY-MM-DD`, 메시지는 `m<id>|MM-DD HH:mm|<표시이름>|<본문>`
import { ANCHOR_BUDGET_SHARE, ANCHOR_BUSY_DAYS, ANCHOR_FIRST_N, PROMPT_RESERVE_TOKENS } from "@/lib/config";
import type { ChatMessage, MsgKind } from "@/lib/parse/parse";
import { type ChatStats, computeStats } from "@/lib/stats/compute";
import { statsForPrompt } from "@/lib/stats/view";
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
  /** transcript 첫 메시지 시각(ISO +09:00) */
  cutoffAt: string;
  /** 시스템 메시지를 뺀 전체 메시지 수 */
  msgTotal: number;
  /** transcript에 담은 메시지 수(anchors 제외) */
  msgSent: number;
  /** 전체 통계. 서버의 자리표시자 해석이 쓴다. 모델에게는 statsForPrompt로 줄여 보낸다 */
  stats: ChatStats;
  /**
   * transcript 앞의 메시지 중 첫 ANCHOR_FIRST_N개와 메시지 수 상위 ANCHOR_BUSY_DAYS일. tokenBudget × anchorShare 안에서
   * 묶음마다 앞에서부터 담는다. 대화 전체가 tokenBudget에 들어가면 빈 문자열이다
   */
  anchors: string;
  /** 마지막 메시지까지 이어지는 최근 구간. 1건 이상이고, 가장 최근 메시지가 예산보다 길면 그 본문을 자른(끝에 …) 한 줄이다 */
  transcript: string;
  /** anchors·transcript에서 가린 개수. 키: phone·email·account·rrn·url·sensitive */
  maskCounts: Record<string, number>;
}

const MESSAGE_LINE = /^m(\d+)\|(\d{2}-\d{2}) (\d{2}:\d{2})\|([^|\n]{1,20})\|(.*)$/u;
const DAY_HEADER = /^# (\d{4}-\d{2}-\d{2})$/;

/** message의 header는 이 줄 앞의 가장 가까운 날짜 헤더(YYYY-MM-DD)이고, 없으면 null이다 */
export type BlockLine =
  | { type: "header"; date: string }
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

/** 덩어리 하나의 추정 토큰. 줄마다 (글자 수 + 1) × tokensPerChar이므로 (전체 글자 수 + 1) × tokensPerChar, 빈 덩어리는 0 */
const blockTokens = (block: string, tokensPerChar: number) => (block === "" ? 0 : (block.length + 1) * tokensPerChar);

/** 모델에게 보이는 stats(statsForPrompt)의 추정 토큰. JSON 글자 수로 어림한다 */
const promptStatsTokens = (stats: ChatStats, tokensPerChar: number) =>
  JSON.stringify(statsForPrompt(stats)).length * tokensPerChar;

/**
 * 페이로드의 추정 토큰(글자 수 × tokensPerChar).
 * - text: anchors + transcript. buildPayload가 tokenBudget 안으로 맞추는 몫이다
 * - total: text + 모델에게 보이는 stats(statsForPrompt). system 프롬프트와 편별 지시는 들어 있지 않다
 */
export function payloadTokens(
  p: Pick<Payload, "stats" | "anchors" | "transcript">,
  tokensPerChar: number,
): { text: number; total: number } {
  const text = blockTokens(p.anchors, tokensPerChar) + blockTokens(p.transcript, tokensPerChar);
  return { text, total: text + promptStatsTokens(p.stats, tokensPerChar) };
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
  /** 줄 머리 `m<id>|MM-DD HH:mm|<표시이름>|`. line = head + 본문 */
  head: string;
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
  const head = `m${m.id}|${day.slice(5)} ${time}|${m.sender}|`;
  return { day, head, line: head + body, masked, sensitive };
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

type BuildInput = {
  messages: ChatMessage[];
  me: string;
  concept: Payload["concept"];
  kind: Payload["kind"];
  tokenBudget: number;
  tokensPerChar: number;
  /** anchors가 tokenBudget에서 쓸 수 있는 비율. 기본 ANCHOR_BUDGET_SHARE */
  anchorShare?: number;
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
 * tokenBudget은 anchors + transcript 몫이다(payloadTokens(p).text ≤ tokenBudget, 줄바꿈과 날짜 헤더 포함).
 * stats·system 프롬프트 몫은 호출하는 쪽이 빼고 넘긴다(buildPayloadForBudget). 예산을 줄여 다시 만들면 이 몫도 그만큼 줄어든다.
 * - 대화 전체가 tokenBudget에 들어가면 모두 transcript이고 anchors는 비어 있다
 * - 아니면 anchors 몫(tokenBudget × anchorShare)을 떼어 두고, transcript를 마지막 메시지부터 거꾸로 채운다.
 *   anchors는 첫 N개와 상위 날짜를 묶음마다 공평하게 나눠 담고, anchors가 남긴 몫은 transcript가 마저 쓴다
 * - 가장 최근 메시지 한 줄조차 tokenBudget보다 길면 그 본문을 잘라(끝에 …) 넣는다. transcript는 늘 1건 이상이다
 * 시스템 메시지를 뺀 메시지가 없거나, 잘라도 날짜 헤더와 줄 머리조차 안 들어가는 tokenBudget이면 던진다.
 */
export function buildPayload(input: BuildInput): Payload {
  const chat = chatLines(input.messages);
  return assemble(chat, computeStats(chat), input);
}

/**
 * 입력 예산 전체(inputBudget)에서 PROMPT_RESERVE_TOKENS와 모델에게 보이는 stats(statsForPrompt) 몫을 빼고,
 * 남은 몫을 tokenBudget으로 buildPayload와 같이 만든다(stats는 한 번만 센다). 남은 몫이 1,000 미만이면 던진다
 */
export function buildPayloadForBudget(input: Omit<BuildInput, "tokenBudget"> & { inputBudget: number }): Payload {
  const { inputBudget, ...rest } = input;
  const chat = chatLines(rest.messages);
  const stats = computeStats(chat);
  const tokenBudget = inputBudget - PROMPT_RESERVE_TOKENS - promptStatsTokens(stats, rest.tokensPerChar);
  if (tokenBudget < MIN_TEXT_BUDGET) throw new Error("입력 예산이 모자라다: 통계·프롬프트 몫을 빼면 대화에 쓸 몫이 1,000 미만이다");
  return assemble(chat, stats, { ...rest, tokenBudget });
}

function assemble(chat: ChatLine[], stats: ChatStats, input: BuildInput): Payload {
  const { me, concept, kind, tokenBudget, tokensPerChar, anchorShare = ANCHOR_BUDGET_SHARE } = input;

  const cache = new Map<number, Rendered>();
  const rendered = (i: number): Rendered => {
    let r = cache.get(i);
    if (!r) cache.set(i, (r = render(chat[i])));
    return r;
  };
  const lineCost = (r: Rendered) => (r.line.length + 1) * tokensPerChar;
  const HEADER_COST = ("# YYYY-MM-DD".length + 1) * tokensPerChar;

  // 가장 최근 메시지 한 줄(과 날짜 헤더)조차 예산보다 길면 본문을 잘라 둔다. 아래 채우기는 잘린 줄을 쓴다.
  // 본문 글자 수 n은 예산에서 헤더·줄 머리·…·줄바꿈을 뺀 값이고, 소수점 오차로 넘치면 한 글자씩 줄인다
  const lastIdx = chat.length - 1;
  const fitsAlone = (r: Rendered) => lineCost(r) + HEADER_COST <= tokenBudget;
  const newest = rendered(lastIdx);
  if (!fitsAlone(newest)) {
    let n = Math.floor((tokenBudget - HEADER_COST) / tokensPerChar) - 1 - newest.head.length - "…".length;
    while (n >= 0 && !fitsAlone(cutLine(newest, n))) n--;
    if (n < 0) throw new Error("예산이 모자라다: 날짜 헤더와 줄 머리조차 들어가지 않는다");
    cache.set(lastIdx, cutLine(newest, n));
  }

  // transcript = chat[start..]. 거꾸로 늘리며, 날짜가 바뀌면 헤더 줄 몫도 센다(used는 transcript의 blockTokens와 같다)
  let start = chat.length;
  let used = 0;
  let day: string | null = null;
  const extend = (limit: number) => {
    for (let i = start - 1; i >= 0; i--) {
      const r = rendered(i);
      const c = lineCost(r) + (r.day === day ? 0 : HEADER_COST);
      if (used + c > limit) break;
      used += c;
      start = i;
      day = r.day;
    }
  };

  extend(tokenBudget);
  let anchorIdx: number[] = [];
  if (start > 0) {
    // 다 들어가지 않는다: anchors 몫을 떼어 두고 다시 채운다. 그 몫으로 마지막 메시지조차 못 넣으면 전체 예산으로 넣는다
    const anchorBudget = Math.floor(tokenBudget * anchorShare);
    start = chat.length;
    used = 0;
    day = null;
    extend(tokenBudget - anchorBudget);
    if (start === chat.length) extend(tokenBudget);
    anchorIdx = pickAnchors(start, Math.min(anchorBudget, tokenBudget - used));
    // anchors가 남긴 몫으로 transcript를 마저 늘리고, transcript와 겹친 anchors는 뺀다(뒤쪽만 빠져서 anchors 몫은 줄기만 한다)
    extend(tokenBudget - blockTokens(joinBlock(anchorIdx.map(rendered)), tokensPerChar));
    anchorIdx = anchorIdx.filter((i) => i < start);
  }

  /**
   * chat[0..limit) 중 anchors를 고른다. 묶음은 첫 ANCHOR_FIRST_N개와 상위 날짜(메시지 수, 동률이면 이른 날짜)마다 하나다.
   * 예산은 묶음끼리 공평하게 나눈다(다 담아도 남는 묶음의 몫은 나머지가 나눠 갖는다). 묶음마다 시간순 앞에서부터 담는다
   */
  function pickAnchors(limit: number, budget: number): number[] {
    const firstN = Math.min(ANCHOR_FIRST_N, limit);
    const busy = Object.entries(stats.dailyCounts)
      .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
      .slice(0, ANCHOR_BUSY_DAYS)
      .map(([d]) => d);
    const byDay = new Map(busy.map((d) => [d, [] as number[]]));
    for (let i = firstN; i < limit; i++) byDay.get(kst(chat[i].ts).day)?.push(i);
    const groups = [Array.from({ length: firstN }, (_, i) => i), ...busy.map((d) => byDay.get(d)!)];

    // 묶음 안에서 앞에서부터 담을 때의 누적 비용
    const prefixCost = (idx: number[], cap: number): { cost: number; n: number } => {
      let cost = 0;
      let d: string | null = null;
      let n = 0;
      for (const i of idx) {
        const r = rendered(i);
        const c = lineCost(r) + (r.day === d ? 0 : HEADER_COST);
        if (cost + c > cap) break;
        cost += c;
        d = r.day;
        n++;
      }
      return { cost, n };
    };
    const need = groups.map((g) => prefixCost(g, Infinity).cost);
    const share = new Array<number>(groups.length).fill(0);
    let left = budget;
    [...groups.keys()]
      .sort((a, b) => need[a] - need[b])
      .forEach((k, j, order) => {
        share[k] = Math.min(need[k], left / (order.length - j));
        left -= share[k];
      });
    // 서로 다른 묶음은 날짜가 겹치지 않거나(상위 날짜끼리) 첫 N개 뒤에 이어져서, 합친 덩어리의 비용은 묶음 비용의 합 이하다
    return groups.flatMap((g, k) => g.slice(0, prefixCost(g, share[k]).n)).sort((a, b) => a - b);
  }
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
    cutoffAt: kst(chat[start].ts).iso,
    msgTotal: stats.total,
    msgSent: sentIdx.length,
    stats,
    anchors: joinBlock(anchorIdx.map(rendered)),
    transcript: joinBlock(sentIdx.map(rendered)),
    maskCounts,
  };
}
