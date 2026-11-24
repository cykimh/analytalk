// 생성 API 테스트 도구: 공식 SSE를 돌려주는 가짜 Anthropic, 가짜 내부 fetch, 즉시 실행하는 schedule, 초대 코드 세션.
// 실제 API는 부르지 않는다. 대화는 줄 모양만 있는 가짜이고 이름은 ALLOWED_NAMES의 표시 이름이다.
// memoryRepo의 하루 건수 한도는 실제 날짜로 계산돼 매달 1일에는 2건까지만 만들 수 있다. 저장소 하나에서 대화는 2건까지만 만든다.
import Anthropic from "@anthropic-ai/sdk";
import { SESSION_COOKIE } from "@/lib/config";
import { hashCode } from "@/lib/invite/code";
import { signSession } from "@/lib/invite/session";
import type { ChatMessage } from "@/lib/parse/parse";
import { buildPayload, type Payload } from "@/lib/payload/build";
import { handleInternalEpisode } from "@/lib/server/handlers/internal";
import { memoryRepo } from "@/lib/server/repo";
import { type HandlerDeps, toResponse } from "@/lib/server/route";

// ── 공식 SSE 형식(event: … / data: …) ──

export type Ev = { type: string; [k: string]: unknown };
const enc = new TextEncoder();
const frame = (e: Ev) => enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);

/** message_start의 usage. 원가가 작아서 주간·일간 한도에 걸리지 않는다 */
export const START_USAGE = { input_tokens: 100, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
export const messageStart = (model = "claude-opus-5-5"): Ev => ({
  type: "message_start",
  message: {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { ...START_USAGE },
  },
});
export const textStart: Ev = { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
export const delta = (text: string): Ev => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
export const blockStop: Ev = { type: "content_block_stop", index: 0 };
export const messageDelta = (stop_reason: string, output_tokens = 200): Ev => ({
  type: "message_delta",
  delta: { stop_reason, stop_sequence: null },
  usage: { output_tokens },
});
export const messageStop: Ev = { type: "message_stop" };
/** 스트림 중간 SSE 오류 이벤트 */
export const sseError = (type: string): Ev => ({ type: "error", error: { type, message: type } });

/**
 * 편 요청 하나에 돌려줄 응답.
 * - status: JSON 오류 본문의 HTTP 응답
 * - steps: SSE 이벤트를 차례로 보낸다. 함수는 그 자리에서 기다린다(스트림을 붙잡아 둔다). open이면 끝에 닫지 않는다
 */
export type Reply = { status: number; error: object } | { steps: (Ev | (() => Promise<void>))[]; open?: boolean };

/** text를 두 조각으로 보내고 닫는 응답 */
export const whole = (text: string, o: { stop?: string; model?: string } = {}): Reply => ({
  steps: [messageStart(o.model), textStart, delta(text.slice(0, 20)), delta(text.slice(20)), blockStop, messageDelta(o.stop ?? "end_turn"), messageStop],
});

/** text를 보낸 뒤 열어 둔다(마감 abort를 기다린다) */
export const cut = (text: string): Reply => ({ steps: [messageStart(), textStart, delta(text)], open: true });

export interface StreamCall {
  n: number;
  body: { model: string; messages: { role: string; content: unknown }[] } & Record<string, unknown>;
}

/** JSON 오류 본문의 HTTP 응답 */
const errorResponse = (r: { status: number; error: object }) =>
  new Response(JSON.stringify({ type: "error", error: r.error }), { status: r.status, headers: { "content-type": "application/json" } });

/** count_tokens 응답: 토큰 수, 또는 JSON 오류 본문의 HTTP 응답 */
export type Counted = () => number | { status: number; error: object };

/** 요청을 기록하고 reply(편 번호, 그 편의 몇 번째 호출)로 응답하는 Anthropic 클라이언트. count_tokens는 counted()를 돌려준다 */
export function fakeAnthropic(reply: (n: number, call: number) => Reply, counted: Counted = () => 1000) {
  const streams: StreamCall[] = [];
  const counts: Record<string, unknown>[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body));
    if (String(url).includes("/v1/messages/count_tokens")) {
      counts.push(body);
      const c = counted();
      return typeof c === "number" ? Response.json({ input_tokens: c }) : errorResponse(c);
    }
    const n = Number(/episode는 (\d)이다/.exec(JSON.stringify(body.messages))?.[1]);
    const call = streams.filter((s) => s.n === n).length + 1;
    streams.push({ n, body });
    const r = reply(n, call);
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

// ── 가짜 대화와 편 출력 ──

const kst = (d: number, h: number, mi: number) => Date.UTC(2026, 9, d, h, mi) - 9 * 3_600_000;

/** 2026-10-01~03 저녁마다 철수·민지가 주고받는 1:1 대화. variant가 다르면 마지막 줄이 달라 해시도 다르다 */
export function makePayload(variant = 0): Payload {
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
  return buildPayload({ messages, me: "민지", concept: "couple", kind: "pair", tokenBudget: 100_000, tokensPerChar: 1 });
}

const section = (title: string) => ({
  icon: "🌙",
  title,
  about: "pair",
  paragraphs: [{ key: "p1", text: "저녁마다 짧게 주고받았어요", evidence_ids: ["e1"] }],
  evidence: [{ id: "e1", msg_id: "m1", quote: "쉬는 중" }],
});

/** 검증을 통과하는(done) n편 출력. 섹션 2개 */
export function episodeJson(n: number, over: Record<string, unknown> = {}) {
  return {
    episode: n,
    safety: { flag: "none" },
    declined_topics: [],
    reading_notes: [{ range: "10-01~10-03", note: "저녁마다 이야기했다" }],
    headline: `${n}편 헤드라인`,
    dek: "사흘 동안의 흐름",
    sections: [section("저녁의 리듬"), section("주말 약속")],
    next_teaser: n === 4 ? null : "다음 편 예고",
    ...over,
  };
}

/** n편 출력을 2번째 섹션의 인용 앞에서 자른 글. 완결된 섹션은 1개다 */
export function cutInSecondSection(n: number, over: Record<string, unknown> = {}): string {
  const raw = JSON.stringify(episodeJson(n, over));
  return raw.slice(0, raw.lastIndexOf('"quote"'));
}

// ── 핸들러 deps ──

export const CODE = "GOOD234567";
export const OTHER_CODE = "OTHR234567";
export const SECRETS = { session: "test-session-secret-0123456789abcdef", internal: "test-internal-secret-0123456789abcdef" };
export const BASE = "https://analytalk.example.com";

export interface InternalCall {
  url: string;
  headers: Headers;
  body: { id: string; n: number; payload: unknown };
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * memoryRepo + 가짜 Anthropic + 가짜 내부 fetch로 HandlerDeps를 만든다.
 * - 내부 fetch는 기본으로 handleInternalEpisode를 같은 deps로 부른다(다른 함수 호출 흉내). internal로 바꿀 수 있다
 * - schedule은 기본으로 즉시 실행하고 settle()이 끝날 때까지 기다린다. manual이면 모아 두고 runQueued()로 돌린다
 * - 시각은 실제 시각(memoryRepo의 now()와 같다)에 skew를 더한 것
 */
export async function harness(
  o: {
    reply?: (n: number, call: number) => Reply;
    counted?: Counted;
    monthlyLimit?: number;
    internal?: Fetch;
    deadlineMs?: number;
  } = {},
) {
  const repo = memoryRepo({
    invites: [
      { code: CODE, monthlyLimit: o.monthlyLimit ?? 2 },
      { code: OTHER_CODE, monthlyLimit: 2 },
    ],
  });
  const anthropic = fakeAnthropic(o.reply ?? ((n) => whole(JSON.stringify(episodeJson(n)))), o.counted);
  const pending: Promise<void>[] = [];
  const queued: (() => Promise<void>)[] = [];
  const internal: InternalCall[] = [];
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
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      internal.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      if (o.internal) return o.internal(url, init ?? {});
      return toResponse(await handleInternalEpisode(new Request(url, init), deps));
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
    internal,
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
