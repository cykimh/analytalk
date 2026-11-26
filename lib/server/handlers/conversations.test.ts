import { afterEach, describe, expect, it, vi } from "vitest";
import { CYCLE_ANCHOR_DAY, DEFAULT_EST_COST_USD, inputTokenBudgetFor, DEFAULT_MODEL, PROMPT_RESERVE_TOKENS, TOKENS_PER_CHAR } from "@/lib/config";
import { retryBuildInput } from "@/lib/client/worker";
import { buildPayloadForBudget } from "@/lib/payload/build";
import { syntheticGroupChat } from "@/test/syntheticChat";
import { PROMPT_VERSION } from "@/lib/llm/prompt";
import { type Payload, payloadTokens } from "@/lib/payload/build";
import { sha256Hex } from "@/lib/payload/hash";
import type { ClaimResult } from "@/lib/server/repo";
import {
  blockStop,
  cut,
  cutInSecondSection,
  delta,
  episodeJson,
  harness,
  makePayload,
  messageDelta,
  messageStart,
  messageStop,
  request,
  SECRETS,
  textStart,
  until,
} from "@/test/generation";
import { nextCycleStart, verifyInternal } from "../jobs";
import { handleDeleteConversation } from "./conversation";
import { handleCreateConversation } from "./conversations";
import { handleStatus } from "./status";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const create = (cookie: string | null, body: unknown) => request("POST", "/api/conversations", cookie, body);
const statusOf = (cookie: string, id: string) => request("GET", `/api/conversations/${id}/status`, cookie);

/** payload의 transcript 끝에 줄을 붙여 payloadTokens(p).text를 정확히 target으로 맞춘다 */
function withTextTokens(p: Payload, target: number): Payload {
  const last = p.transcript.split("\n").at(-1)!;
  const [, id, stamp] = /^m(\d+)\|([^|]+)\|/.exec(last)!;
  const head = `m${Number(id) + 1}|${stamp}|A|`;
  const body = "가".repeat(target - payloadTokens(p, TOKENS_PER_CHAR).text - 1 - head.length);
  return { ...p, transcript: `${p.transcript}\n${head}${body}`, msgSent: p.msgSent + 1 };
}

describe("POST /api/conversations", () => {
  it("정상 흐름: 202, 1편 message_start에서(텍스트 전) 서명한 내부 호출 3번, 4편 모두 done, 편마다 startEpisode 1번 (Review Focus 1)", async () => {
    let dispatchedBeforeText = -1;
    const h = await harness({
      reply: (n) => {
        const text = JSON.stringify(episodeJson(n));
        if (n !== 1) return { steps: [messageStart(), textStart, delta(text), blockStop, messageDelta("end_turn"), messageStop] };
        return {
          steps: [
            messageStart(),
            async () => {
              await until(() => h.internal.length === 3);
              dispatchedBeforeText = h.internal.length;
            },
            textStart,
            delta(text),
            blockStop,
            messageDelta("end_turn"),
            messageStop,
          ],
        };
      },
    });
    const start = vi.spyOn(h.repo, "startEpisode");
    const payload = makePayload();

    const res = await handleCreateConversation(create(h.cookie, payload), h.deps);
    expect(res.status).toBe(202);
    const { id } = res.body as { id: string };
    await h.settle();

    expect(dispatchedBeforeText).toBe(3);
    const sha = await sha256Hex(JSON.stringify(payload));
    expect(h.internal.map((c) => c.body.n).sort()).toEqual([2, 3, 4]);
    for (const call of h.internal) {
      expect(verifyInternal(call.headers.get("x-analytalk-signature"), { id, n: call.body.n, payloadSha256: sha }, Date.now(), SECRETS.internal)).toBe(
        true,
      );
    }
    expect(start.mock.calls.map(([, n]) => n).sort()).toEqual([1, 2, 3, 4]);
    expect(h.streams.map((s) => s.n).sort()).toEqual([1, 2, 3, 4]);

    // 탭을 닫았다 열어도 status는 DB만 읽는다
    const calls = { streams: h.streams.length, counts: h.counts.length, internal: h.internal.length };
    const status = await handleStatus(statusOf(h.cookie, id), h.deps, id);
    expect(status.status).toBe(200);
    expect((status.body as { episodes: { status: string }[] }).episodes.map((e) => e.status)).toEqual(["done", "done", "done", "done"]);
    expect({ streams: h.streams.length, counts: h.counts.length, internal: h.internal.length }).toEqual(calls);
  });

  it("countTokens에는 1편 요청의 model·system·messages·thinking·output_config만 보낸다", async () => {
    const h = await harness();
    h.state.manual = true;
    await handleCreateConversation(create(h.cookie, makePayload()), h.deps);
    expect(h.counts).toHaveLength(1);
    expect(Object.keys(h.counts[0]).sort()).toEqual(["messages", "model", "output_config", "system", "thinking"]);
    expect(JSON.stringify(h.counts[0].messages)).toContain("episode는 1이다");
  });

  it("같은 payload로 두 번 → 200·같은 id. 한도·countTokens·stream이 늘지 않는다 (Review Focus 4)", async () => {
    const h = await harness({ monthlyLimit: 1 });
    const payload = makePayload();
    const first = await handleCreateConversation(create(h.cookie, payload), h.deps);
    expect(first.status).toBe(202);
    // 버튼을 두 번 누름: 1편이 도는 중
    const again = await handleCreateConversation(create(h.cookie, payload), h.deps);
    await h.settle();
    // 다 끝난 뒤 같은 파일을 다시 올림
    const later = await handleCreateConversation(create(h.cookie, JSON.parse(JSON.stringify(payload))), h.deps);
    expect([again.status, later.status]).toEqual([200, 200]);
    expect(again.body).toEqual(first.body);
    expect(later.body).toEqual(first.body);
    expect(h.counts).toHaveLength(1);
    expect(h.streams.filter((s) => s.n === 1)).toHaveLength(1);
    expect(h.streams).toHaveLength(4);
  });

  it("429 enforced_spend_limit_reached → 정지, 다음 POST는 423, Anthropic 재호출 0번(생성·countTokens 모두) (Review Focus 3)", async () => {
    const h = await harness({
      reply: () => ({
        status: 429,
        error: { type: "rate_limit_error", message: "spend limit", details: { error_code: "enforced_spend_limit_reached" } },
      }),
    });
    const res = await handleCreateConversation(create(h.cookie, makePayload(0)), h.deps);
    expect(res.status).toBe(202);
    await h.settle();
    expect(h.counts).toHaveLength(1);
    const { id } = res.body as { id: string };
    const status = await handleStatus(statusOf(h.cookie, id), h.deps, id);
    expect(status.body).toEqual({
      episodes: [
        { n: 1, status: "failed", progress: null, errorCode: "limit" },
        { n: 2, status: "queued", progress: null, errorCode: null },
        { n: 3, status: "queued", progress: null, errorCode: null },
        { n: 4, status: "queued", progress: null, errorCode: null },
      ],
      paused: true,
    });

    const claim = vi.spyOn(h.repo, "claim");
    const next = await handleCreateConversation(create(h.cookie, makePayload(1)), h.deps);
    await h.settle();
    expect(next).toEqual({ status: 423, body: { error: "paused" } });
    expect(h.counts).toHaveLength(1);
    expect(h.streams).toHaveLength(1);
    expect(h.internal).toHaveLength(0);
    expect(claim).not.toHaveBeenCalled();
  });

  it("전역 정지 중: 같은 payload는 200·기존 id, 새 payload는 countTokens·claim 전에 423. 정지가 풀리면 받는다", async () => {
    const h = await harness();
    h.state.manual = true;
    const payload = makePayload(0);
    const first = await handleCreateConversation(create(h.cookie, payload), h.deps);
    expect(first.status).toBe(202);
    await h.repo.setPaused(new Date(Date.now() + 3_600_000));
    const claim = vi.spyOn(h.repo, "claim");

    // claim_conversation처럼 중복 확인이 정지보다 먼저다
    expect(await handleCreateConversation(create(h.cookie, payload), h.deps)).toEqual({ status: 200, body: first.body });
    expect(await handleCreateConversation(create(h.cookie, makePayload(1)), h.deps)).toEqual({ status: 423, body: { error: "paused" } });
    expect(h.counts).toHaveLength(1);
    expect(claim).not.toHaveBeenCalled();

    await h.repo.setPaused(new Date(Date.now() - 1));
    expect((await handleCreateConversation(create(h.cookie, makePayload(1)), h.deps)).status).toBe(202);
    expect(h.counts).toHaveLength(2);
  });

  describe("countTokens가 거부되면 오류를 분류한다", () => {
    it.each([
      [
        "credit_exhausted(402)",
        { status: 402, error: { type: "billing_error", message: "Your credit balance is too low" } },
        () => nextCycleStart(new Date(), CYCLE_ANCHOR_DAY),
      ],
      [
        "spend_limit(429)",
        { status: 429, error: { type: "rate_limit_error", message: "spend limit", details: { error_code: "enforced_spend_limit_reached" } } },
        () => {
          const now = new Date();
          return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
        },
      ],
    ])("%s → 정지 시각을 걸고 423. claim 없음, 다음 POST는 countTokens 없이 423", async (kind, reply, until) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const h = await harness({ counted: () => reply });
      const setPaused = vi.spyOn(h.repo, "setPaused");
      const claim = vi.spyOn(h.repo, "claim");
      expect(await handleCreateConversation(create(h.cookie, makePayload(0)), h.deps)).toEqual({ status: 423, body: { error: "paused" } });
      expect(setPaused.mock.calls).toEqual([[until()]]);
      expect(claim).not.toHaveBeenCalled();
      expect(error.mock.calls.map(([m]) => m)).toEqual([`[conversations] countTokens 실패: ${kind.split("(")[0]}`]);

      expect((await handleCreateConversation(create(h.cookie, makePayload(1)), h.deps)).status).toBe(423);
      expect(h.counts).toHaveLength(1);
      expect(h.streams).toHaveLength(0);
    });

    it("그 밖의 오류(5xx 등)는 502 count_tokens_failed. 정지하지 않고 오류 종류만 남긴다", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const h = await harness({ counted: () => ({ status: 500, error: { type: "api_error", message: "Internal server error" } }) });
      const setPaused = vi.spyOn(h.repo, "setPaused");
      const claim = vi.spyOn(h.repo, "claim");
      expect(await handleCreateConversation(create(h.cookie, makePayload()), h.deps)).toEqual({
        status: 502,
        body: { error: "count_tokens_failed" },
      });
      expect(setPaused).not.toHaveBeenCalled();
      expect(claim).not.toHaveBeenCalled();
      expect(error.mock.calls.map(([m]) => m)).toEqual(["[conversations] countTokens 실패: retryable"]);
    });
  });

  it("내부 fetch가 401이면 2~4편은 failed(dispatch), 1편은 그대로 done", async () => {
    const h = await harness({ internal: async () => new Response(null, { status: 401 }) });
    const res = await handleCreateConversation(create(h.cookie, makePayload()), h.deps);
    await h.settle();
    const { id } = res.body as { id: string };
    const status = await handleStatus(statusOf(h.cookie, id), h.deps, id);
    expect((status.body as { episodes: unknown[] }).episodes).toEqual([
      { n: 1, status: "done", progress: null, errorCode: null },
      { n: 2, status: "failed", progress: null, errorCode: "dispatch" },
      { n: 3, status: "failed", progress: null, errorCode: "dispatch" },
      { n: 4, status: "failed", progress: null, errorCode: "dispatch" },
    ]);
    expect(h.streams).toHaveLength(1);
  });

  it("월 1건 코드: POST → DELETE → 같은 payload로 POST → 429 invite_limit (claim 원장은 남는다)", async () => {
    const h = await harness({ monthlyLimit: 1 });
    const payload = makePayload();
    const res = await handleCreateConversation(create(h.cookie, payload), h.deps);
    await h.settle();
    const { id } = res.body as { id: string };
    const del = await handleDeleteConversation(request("DELETE", `/api/conversations/${id}`, h.cookie), h.deps, id);
    expect(del.status).toBe(204);
    const again = await handleCreateConversation(create(h.cookie, payload), h.deps);
    expect(again).toEqual({ status: 429, body: { reason: "invite_limit" } });
  });

  it("2번째 섹션 뒤에서 끊긴 SSE(마감) → DB content는 섹션 1개, status partial", async () => {
    const h = await harness({ reply: (n) => cut(cutInSecondSection(n)), deadlineMs: 150, internal: async () => new Response(null, { status: 202 }) });
    const res = await handleCreateConversation(create(h.cookie, makePayload()), h.deps);
    await h.settle();
    const row = await h.repo.getConversation((res.body as { id: string }).id);
    const first = row!.episodes[0];
    expect(first.status).toBe("partial");
    expect(first.content?.sections.map((s) => s.title)).toEqual(["저녁의 리듬"]);
  });

  it("countTokens가 예산 × 1.05를 넘으면 413 {maxTokens}: (본문+통계+프롬프트 몫) 단위. claim·생성 없음", async () => {
    const budget = inputTokenBudgetFor(DEFAULT_MODEL);
    const h = await harness({ counted: () => 200_000 });
    const claim = vi.spyOn(h.repo, "claim");
    const payload = withTextTokens(makePayload(), 150_000);
    const total = payloadTokens(payload, TOKENS_PER_CHAR).total;
    const res = await handleCreateConversation(create(h.cookie, payload), h.deps);
    expect(res).toEqual({ status: 413, body: { maxTokens: Math.floor(((total + PROMPT_RESERVE_TOKENS) * budget) / 200_000) } });
    expect(claim).not.toHaveBeenCalled();
    expect(h.streams).toHaveLength(0);
  });

  it("countTokens가 예산 × 1.05와 같으면 받는다", async () => {
    const h = await harness({ counted: () => inputTokenBudgetFor(DEFAULT_MODEL) * 1.05 });
    h.state.manual = true;
    expect((await handleCreateConversation(create(h.cookie, makePayload()), h.deps)).status).toBe(202);
  });

  it("ANTHROPIC_MODEL이 예산을 정한다: Sonnet 5.5는 400K까지 받는다", async () => {
    vi.stubEnv("ANTHROPIC_MODEL", "claude-sonnet-5-5");
    const h = await harness({ counted: () => 300_000 });
    h.state.manual = true;
    expect((await handleCreateConversation(create(h.cookie, makePayload()), h.deps)).status).toBe(202);
  });

  it("되돌린 예산에서도 한 번 다시 만들면 통과한다 (Review Focus 3)", async () => {
    vi.stubEnv("ANTHROPIC_MODEL", "claude-opus-5-5");
    // 가짜 countTokens: 요청 글자 수를 그대로 토큰 수로 돌려준다
    let h!: Awaited<ReturnType<typeof harness>>;
    h = await harness({
      counted: () => {
        const r = h.counts.at(-1) as { system: unknown; messages: unknown };
        return JSON.stringify(r.system).length + JSON.stringify(r.messages).length;
      },
    });
    h.state.manual = true;
    const first = {
      messages: syntheticGroupChat(40, 60),
      tone: "fact" as const,
      concept: "group" as const,
      kind: "group" as const,
      tokensPerChar: TOKENS_PER_CHAR,
      inputBudget: 400_000,
    };
    const res1 = await handleCreateConversation(create(h.cookie, buildPayloadForBudget(first)), h.deps);
    expect(res1.status).toBe(413);
    const { maxTokens } = res1.body as { maxTokens: number };
    const res2 = await handleCreateConversation(create(h.cookie, buildPayloadForBudget(retryBuildInput(first, maxTokens))), h.deps);
    expect(res2.status).toBe(202);
  });

  it("meta는 서버가 payload로 만들고 claim에 추정 원가를 넘긴다", async () => {
    const h = await harness();
    h.state.manual = true;
    const claim = vi.spyOn(h.repo, "claim");
    const payload = makePayload();
    await handleCreateConversation(create(h.cookie, payload), h.deps);
    expect(claim).toHaveBeenCalledWith({
      inviteId: expect.any(String),
      concept: "couple",
      payloadSha256: await sha256Hex(JSON.stringify(payload)),
      meta: {
        prompt_version: PROMPT_VERSION,
        kind: "pair",
        period_start: payload.period.start,
        period_end: payload.period.end,
        cutoff_at: payload.cutoffAt,
        msg_total: payload.msgTotal,
        msg_sent: payload.msgSent,
        display_names: payload.members,
        stats: payload.stats,
      },
      estCost: DEFAULT_EST_COST_USD,
    });
    // 만든 직후 1편은 running이고 작업이 하나 예약된다
    const row = await h.repo.getConversation(((await claim.mock.results[0].value) as { id: string }).id);
    expect(row!.episodes.map((e) => e.status)).toEqual(["running", "queued", "queued", "queued"]);
    expect(h.queued).toHaveLength(1);
  });

  it.each([
    ["paused", 423, { error: "paused" }],
    ["invite_limit", 429, { reason: "invite_limit" }],
    ["global_limit", 429, { reason: "global_limit" }],
    ["daily_limit", 429, { reason: "daily_limit" }],
    ["revoked", 401, { error: "unauthorized" }],
  ] as const)("claim %s → %i", async (outcome, status, body) => {
    const h = await harness();
    vi.spyOn(h.repo, "claim").mockResolvedValue({ id: null, outcome } as ClaimResult);
    const res = await handleCreateConversation(create(h.cookie, makePayload()), h.deps);
    expect(res).toEqual({ status, body });
    expect(h.streams).toHaveLength(0);
  });

  it("쿠키 없음 401, 페이로드가 틀리면 400(countTokens 없음)", async () => {
    const h = await harness();
    expect((await handleCreateConversation(create(null, makePayload()), h.deps)).status).toBe(401);
    const bad = await handleCreateConversation(create(h.cookie, { ...makePayload(), transcript: "<script>" }), h.deps);
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: "bad_payload" });
    const notJson = new Request("https://analytalk.example.com/api/conversations", {
      method: "POST",
      headers: { cookie: h.cookie, "content-type": "application/json" },
      body: "{",
    });
    expect((await handleCreateConversation(notJson, h.deps)).status).toBe(400);
    expect(h.counts).toHaveLength(0);
  });

  it("Anthropic 키(client)나 내부 서명 비밀값이 없으면 503. 가짜 클라이언트로 돌지 않는다", async () => {
    const h = await harness();
    const noClient = await handleCreateConversation(create(h.cookie, makePayload()), { ...h.deps, client: null });
    expect(noClient).toEqual({ status: 503, body: { error: "not_ready" } });
    const noSecret = await handleCreateConversation(create(h.cookie, makePayload()), {
      ...h.deps,
      secrets: { ...h.deps.secrets, internal: "" },
    });
    expect(noSecret.status).toBe(503);
    expect(h.counts).toHaveLength(0);
  });
});
