// 생성 API 테스트 도구: 공식 SSE를 돌려주는 가짜 Anthropic, 부르면 던지는 fetch, 즉시 실행하는 schedule, 초대 코드 세션.
// 실제 API는 부르지 않는다. 대화는 줄 모양만 있는 가짜이고 이름은 ALLOWED_NAMES의 표시 이름이다.
// memoryRepo의 하루 건수 한도는 실제 날짜로 계산돼 매달 1일에는 2건까지만 만들 수 있다. 저장소 하나에서 대화는 2건까지만 만든다.
import Anthropic from "@anthropic-ai/sdk";
import { SESSION_COOKIE } from "@/lib/config";
import { hashCode } from "@/lib/invite/code";
import { signSession } from "@/lib/invite/session";
import type { PickableTone } from "@/lib/llm/concepts";
import { buildRequests, type CallPart } from "@/lib/llm/prompt";
import type { ChatMessage } from "@/lib/parse/parse";
import { buildPayload, type Payload } from "@/lib/payload/build";
import { memoryRepo } from "@/lib/server/repo";
import type { HandlerDeps } from "@/lib/server/route";

// ── 공식 SSE 형식(event: … / data: …) ──

export type Ev = { type: string; [k: string]: unknown };
const enc = new TextEncoder();
const frame = (e: Ev) => enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);

/** message_start의 usage. 원가가 작아서 주간·일간 한도에 걸리지 않는다 */
export const START_USAGE = { input_tokens: 100, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
export const messageStart = (model = "claude-sonnet-5-5", usage: Partial<typeof START_USAGE> = {}): Ev => ({
  type: "message_start",
  message: {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { ...START_USAGE, ...usage },
  },
});
export const textStart: Ev = { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
export const delta = (text: string): Ev => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
export const blockStop: Ev = { type: "content_block_stop", index: 0 };
/** stopCategory가 있으면 거절 분류(stop_details)를 싣는다 */
export const messageDelta = (stop_reason: string, output_tokens = 200, stopCategory?: string): Ev => ({
  type: "message_delta",
  delta: {
    stop_reason,
    stop_sequence: null,
    ...(stopCategory ? { stop_details: { type: "refusal", category: stopCategory, explanation: null } } : {}),
  },
  usage: { output_tokens },
});
export const messageStop: Ev = { type: "message_stop" };
/** 스트림 중간 SSE 오류 이벤트 */
export const sseError = (type: string): Ev => ({ type: "error", error: { type, message: type } });

/**
 * 리포트 요청 하나에 돌려줄 응답.
 * - status: JSON 오류 본문의 HTTP 응답
 * - steps: SSE 이벤트를 차례로 보낸다. 함수는 그 자리에서 기다린다(스트림을 붙잡아 둔다). open이면 끝에 닫지 않는다
 */
export type Reply = { status: number; error: object } | { steps: (Ev | (() => Promise<void>))[]; open?: boolean };

/** text를 두 조각으로 보내고 닫는 응답. usage·output은 message_start의 usage와 출력 토큰을 바꾼다 */
export const whole = (
  text: string,
  o: { stop?: string; model?: string; stopCategory?: string; usage?: Partial<typeof START_USAGE>; output?: number } = {},
): Reply => ({
  steps: [
    messageStart(o.model, o.usage),
    textStart,
    delta(text.slice(0, 20)),
    delta(text.slice(20)),
    blockStop,
    messageDelta(o.stop ?? "end_turn", o.output ?? 200, o.stopCategory),
    messageStop,
  ],
});

/** text를 보낸 뒤 열어 둔다(마감 abort를 기다린다) */
export const cut = (text: string): Reply => ({ steps: [messageStart(), textStart, delta(text)], open: true });

export interface StreamCall {
  body: { model: string; messages: { role: string; content: unknown }[] } & Record<string, unknown>;
}

/** JSON 오류 본문의 HTTP 응답 */
const errorResponse = (r: { status: number; error: object }) =>
  new Response(JSON.stringify({ type: "error", error: r.error }), { status: r.status, headers: { "content-type": "application/json" } });

/** count_tokens 응답: 토큰 수, 또는 JSON 오류 본문의 HTTP 응답 */
export type Counted = () => number | { status: number; error: object };

/** 리포트 호출 하나에 돌려줄 응답을 고른다: 몇 번째 리포트 호출인지(1부터)와 그 요청 본문 */
export type ReplyFn = (call: number, body: StreamCall["body"]) => Reply;

/** 요청을 기록하고 reply(몇 번째 리포트 호출인지, 요청 본문)로 응답하는 Anthropic 클라이언트. count_tokens는 counted()를 돌려준다 */
export function fakeAnthropic(reply: ReplyFn, counted: Counted = () => 1000) {
  const streams: StreamCall[] = [];
  const counts: Record<string, unknown>[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body));
    if (String(url).includes("/v1/messages/count_tokens")) {
      counts.push(body);
      const c = counted();
      return typeof c === "number" ? Response.json({ input_tokens: c }) : errorResponse(c);
    }
    streams.push({ body });
    const r = reply(streams.length, body);
    if ("status" in r) return errorResponse(r);
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
      },
    });
    const end = (error?: unknown) => {
      if (closed) return;
      closed = true;
      if (error === undefined) ctrl.close();
      else ctrl.error(error);
    };
    // 실제 fetch처럼 abort되면 본문을 AbortError로 끊는다
    init?.signal?.addEventListener("abort", () => end(new DOMException("This operation was aborted", "AbortError")));
    void (async () => {
      try {
        for (const step of r.steps) {
          if (closed) return;
          if (typeof step === "function") await step();
          else ctrl.enqueue(frame(step));
        }
        if (!r.open) end();
      } catch (e) {
        end(e);
      }
    })();
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { client: new Anthropic({ apiKey: "test", fetch: fetch as typeof globalThis.fetch, maxRetries: 0 }), streams, counts };
}

// ── 가짜 대화와 리포트 출력 ──

const kst = (d: number, h: number, mi: number) => Date.UTC(2026, 9, d, h, mi) - 9 * 3_600_000;

/** 2026-10-01~03 저녁마다 철수·민지가 주고받는 1:1 대화. variant가 다르면 마지막 줄이 달라 해시도 다르다 */
export function makePayload(variant = 0, tone: PickableTone = "fact"): Payload {
  const rows: [string, number, string][] = [];
  for (let d = 1; d <= 3; d++) {
    rows.push(
      ["철수", kst(d, 20, 0), "오늘 뭐해?"],
      ["민지", kst(d, 20, 5), "집에서 쉬는 중 ㅋㅋ"],
      ["철수", kst(d, 20, 6), "영화 볼래?"],
      ["민지", kst(d, 20, 10), "좋아!"],
    );
  }
  rows.push(["민지", kst(3, 21, 0), `잘 자 ${"ㅎ".repeat(variant + 1)}`]);
  const messages: ChatMessage[] = rows.map(([sender, ts, text], id) => ({ id, ts, sender, kind: "text", text, line: id + 1 }));
  return buildPayload({ messages, tone, concept: "couple", kind: "pair", tokenBudget: 100_000, tokensPerChar: 1 });
}

/** 사흘 저녁 다섯 명 단톡. 하루에 민지 5·철수 4·영희 3·지훈 2·수아 1개라 메시지 많은 순은 민지·철수·영희·지훈·수아. 본문은 "<이름> 왔어 <n>" */
export const GROUP_NAMES = ["민지", "철수", "영희", "지훈", "수아"] as const;
export function makeGroupPayload(tone: PickableTone = "fact"): Payload {
  const rows: [string, number, string][] = [];
  for (let d = 1; d <= 3; d++) {
    let minute = 0;
    GROUP_NAMES.forEach((name, k) => {
      for (let j = 0; j < GROUP_NAMES.length - k; j++) rows.push([name, kst(d, 20, minute++), `${name} 왔어 ${d}${j}`]);
    });
  }
  const messages: ChatMessage[] = rows.map(([sender, ts, text], id) => ({ id, ts, sender, kind: "text", text, line: id + 1 }));
  return buildPayload({ messages, tone, concept: "group", kind: "group", tokenBudget: 100_000, tokensPerChar: 1 });
}

const section = (part: string, title: string) => ({
  part,
  icon: "🌙",
  title,
  about: "pair",
  paragraphs: [{ key: "p1", text: "저녁마다 짧게 주고받았어요", evidence_ids: ["e1"] }],
  evidence: [{ id: "e1", msg_id: "m1", quote: "쉬는 중" }],
});

/** 검증을 통과하는(done) 리포트 출력. 섹션 2개 */
export function reportJson(over: Record<string, unknown> = {}) {
  return {
    safety: { flag: "none" },
    declined_topics: [],
    reading_notes: [{ range: "10-01~10-03", note: "저녁마다 이야기했다" }],
    headline: "리포트 헤드라인",
    dek: "사흘 동안의 흐름",
    sections: [section("nag_open", "저녁의 리듬"), section("nag_room", "주말 약속")],
    ...over,
  };
}

/** makePayload 대화의 메시지(m번호)와 그 본문에서 잘라 온 인용 */
const QUOTES: [string, string][] = [
  ["m0", "오늘 뭐해?"],
  ["m1", "쉬는 중"],
  ["m2", "영화 볼래?"],
  ["m3", "좋아!"],
  ["m12", "잘 자"],
];

/**
 * v2.2 분량의 긴 리포트 출력(잔소리하는 친구 구성): 섹션 10개 × 문단 5개, 인용 섹션마다 3개 = 30개.
 * 사람 섹션은 문단마다 근거를 달지 않는다(섹션 단위 근거). 자리표시자는 섹션에 하나뿐이다
 */
export function longReportJson() {
  const parts = ["nag_open", "nag_cards", "nag_cards", "nag_room", "nag_room", "nag_room", "nag_room", "nag_room", "nag_room", "nag_last"];
  const about = (i: number) => (i === 1 ? "철수" : i === 2 ? "민지" : "pair");
  const body = "저녁이 되면 이 방은 다시 살아난다. 한 사람이 운을 떼면 다른 사람이 곧 받아 이어 간다. 이야기는 짧은 말로 시작해 영화 이야기로 번진다. 그리고 늘 같은 말로 끝난다. 다 보여.";
  return reportJson({
    reading_notes: Array.from({ length: 12 }, (_, i) => ({ range: "10-01~10-03", note: `저녁마다 이야기했다 ${"ㅎ".repeat(i + 1)}` })),
    headline: "또 저녁 8시에 모인 두 사람에게 하는 잔소리",
    dek: "사흘 내내 같은 시간, 같은 말. 다 지켜봤다.",
    sections: parts.map((part, i) => ({
      part,
      icon: "🙄",
      title: `잔소리: ${["시작", "철수", "민지", "약속", "저녁", "영화", "주말", "답장", "밤", "끝"][i]}`,
      about: about(i),
      paragraphs: Array.from({ length: 5 }, (_, j) => ({
        key: `p${j + 1}`,
        text: j === 0 && i === 3 ? `철수는 대화를 {{stat:initiations.철수}}번 먼저 열었다. ${body}` : `${i % 2 === 0 ? "민지" : "철수"}의 장면 ${j + 1}. ${body}`,
        evidence_ids: j < 3 ? [`e${j + 1}`] : [],
      })),
      evidence: Array.from({ length: 3 }, (_, k) => {
        const [msg_id, quote] = QUOTES[(i + k) % QUOTES.length];
        return { id: `e${k + 1}`, msg_id, quote };
      }),
    })),
  });
}

// ── v2.5 나눠 쓰기: 호출마다 자기 몫을 쓰는 가짜 응답 ──

/** 요청 본문의 마지막 지시(mid-conversation system 메시지) 글 */
export function instructionOf(body: StreamCall["body"]): string {
  const m = body.messages.at(-1)!;
  return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
}

/** 그 페이로드의 호출 지시 → 몫(intro·people·people_rest·outro). 지시 글이 같으면 같은 호출이다 */
export function partsOf(payload: Payload): (body: StreamCall["body"]) => CallPart {
  const parts = new Map(buildRequests(payload).map((c) => [instructionOf(c.req as unknown as StreamCall["body"]), c.part]));
  return (body) => {
    const part = parts.get(instructionOf(body));
    if (!part) throw new Error("[test] 모르는 지시");
    return part;
  };
}

/** 사람 섹션(잔소리 카드). 근거는 그 사람이 makePayload에서 보낸 메시지 */
const personSection = (name: string) => ({
  part: "nag_cards",
  icon: "🙄",
  title: `${name} 카드`,
  about: name,
  paragraphs: [{ key: "p1", text: `${name}는 저녁마다 짧게 답했다`, evidence_ids: ["e1"] }],
  evidence: [name === "철수" ? { id: "e1", msg_id: "m0", quote: "오늘 뭐해?" } : { id: "e1", msg_id: "m1", quote: "쉬는 중" }],
});

/**
 * makePayload(1:1, 잔소리, small)의 몫별 출력. 인트로는 nag_open 하나와 제목·메모, 개인별은 철수·민지 카드, 마무리는 nag_last.
 * 인트로가 아닌 몫은 제목·메모를 비운다
 */
export function stageJson(part: CallPart, over: Record<string, unknown> = {}) {
  const blank = { reading_notes: [], headline: "", dek: "" };
  switch (part) {
    case "intro":
      return reportJson({ sections: [section("nag_open", "저녁의 리듬")], ...over });
    case "people":
    case "people_rest":
      return reportJson({ ...blank, sections: [personSection("철수"), personSection("민지")], ...over });
    case "outro":
      return reportJson({ ...blank, sections: [section("nag_last", "마지막 한마디")], ...over });
  }
}

/** 지시 마지막 줄(이번 응답의 몫)로 몫을 가린다. 개인별 둘(people·people_rest)은 가리지 않는다(people) */
export function partFromInstruction(body: StreamCall["body"]): CallPart {
  const last = instructionOf(body).split("\n").at(-1) ?? "";
  if (last.startsWith("이번 응답: [1.")) return "intro";
  if (last.startsWith("이번 응답: [3.")) return "outro";
  return "people";
}

/** 기본 응답: 몫마다 makePayload(철수·민지)의 stageJson을 그대로 끝낸다. 몇 번째 호출이든 성공한다 */
export const stagedDefault: ReplyFn = (_call, body) => whole(JSON.stringify(stageJson(partFromInstruction(body))));

/** 몫마다 응답을 고르는 reply. 몫에 없는 것은 stageJson 그대로 끝낸다. 함수는 그 몫의 몇 번째 시도인지(1부터)를 받는다 */
export function staged(payload: Payload, over: Partial<Record<CallPart, Reply | ((attempt: number) => Reply)>> = {}): ReplyFn {
  const partOf = partsOf(payload);
  const tries = new Map<CallPart, number>();
  return (_call, body) => {
    const part = partOf(body);
    const attempt = (tries.get(part) ?? 0) + 1;
    tries.set(part, attempt);
    const r = over[part];
    if (r === undefined) return whole(JSON.stringify(stageJson(part)));
    return typeof r === "function" ? r(attempt) : r;
  };
}

/** 리포트 출력을 2번째 섹션의 인용 앞에서 자른 글. 완결된 섹션은 1개다 */
export function cutInSecondSection(over: Record<string, unknown> = {}): string {
  const raw = JSON.stringify(reportJson(over));
  return raw.slice(0, raw.lastIndexOf('"quote"'));
}

// ── 핸들러 deps ──

export const CODE = "GOOD234567";
export const OTHER_CODE = "OTHR234567";
export const SECRETS = { session: "test-session-secret-0123456789abcdef" };
export const BASE = "https://analytalk.example.com";

/** deps.fetch로 나간 요청. 생성 흐름은 fetch를 부르지 않는다(0건이어야 한다) */
export interface FetchCall {
  url: string;
}

/**
 * memoryRepo + 가짜 Anthropic + 부르면 던지는 fetch로 HandlerDeps를 만든다.
 * - deps.fetch는 요청을 fetches에 남기고 "예상 못 한 fetch"로 던진다(생성·다시 쓰기는 자기 호출을 하지 않는다)
 * - schedule은 기본으로 즉시 실행하고 settle()이 끝날 때까지 기다린다. manual이면 모아 두고 runQueued()로 돌린다
 * - 시각은 실제 시각(memoryRepo의 now()와 같다)에 skew를 더한 것
 */
export async function harness(
  o: {
    reply?: ReplyFn;
    counted?: Counted;
    monthlyLimit?: number;
    deadlineMs?: number;
  } = {},
) {
  const repo = memoryRepo({
    invites: [
      { code: CODE, monthlyLimit: o.monthlyLimit ?? 2 },
      { code: OTHER_CODE, monthlyLimit: 2 },
    ],
  });
  const anthropic = fakeAnthropic(o.reply ?? stagedDefault, o.counted);
  const pending: Promise<void>[] = [];
  const queued: (() => Promise<void>)[] = [];
  const fetches: FetchCall[] = [];
  const state = { manual: false, skew: 0 };

  const deps: HandlerDeps = {
    repo,
    client: anthropic.client,
    schedule: (task) => {
      if (state.manual) queued.push(task);
      else pending.push(task());
    },
    deadlineAt: () => Date.now() + (o.deadlineMs ?? 60_000),
    now: () => Date.now() + state.skew,
    fetch: (async (input: string | URL | Request) => {
      const url = String(input);
      fetches.push({ url });
      throw new Error(`[test] 예상 못 한 fetch: ${url}`);
    }) as typeof fetch,
    secrets: { ...SECRETS },
    production: true,
  };

  const cookieFor = async (code: string) => {
    const invite = await repo.findInvite(hashCode(code));
    return `${SESSION_COOKIE}=${signSession(invite!.id, Date.now() + 86_400_000, SECRETS.session)}`;
  };

  return {
    deps,
    repo,
    streams: anthropic.streams,
    counts: anthropic.counts,
    fetches,
    state,
    cookie: await cookieFor(CODE),
    otherCookie: await cookieFor(OTHER_CODE),
    /** 예약된 작업(그 작업이 예약한 것까지)이 모두 끝날 때까지 */
    async settle() {
      while (pending.length > 0) await pending.shift();
    },
    /** manual로 모아 둔 작업을 돌린다(settle로 기다린다) */
    runQueued() {
      for (const task of queued.splice(0)) pending.push(task());
    },
    queued,
  };
}

export type Harness = Awaited<ReturnType<typeof harness>>;

/** 쿠키·JSON 본문을 단 요청 */
export function request(method: string, path: string, cookie: string | null, body?: unknown): Request {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** cond가 참이 될 때까지 기다린다(1초) */
export async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await sleep(5);
  if (!cond()) throw new Error("조건이 1초 안에 채워지지 않았다");
}
