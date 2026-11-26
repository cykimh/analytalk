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
  reportJson,
  harness,
  makePayload,
  messageDelta,
  messageStart,
  messageStop,
  request,
  textStart,
} from "@/test/generation";
import { nextCycleStart } from "../jobs";
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
  it("정상 흐름: 202, 스트림 1번, report done, startReport 1번, fetch 0번. status는 DB만 읽는다 (Review Focus 1)", async () => {
    const h = await harness({
      reply: () => ({ steps: [messageStart(), textStart, delta(JSON.stringify(reportJson())), blockStop, messageDelta("end_turn"), messageStop] }),
    });
    const start = vi.spyOn(h.repo, "startReport");
    const payload = makePayload();

    const res = await handleCreateConversation(create(h.cookie, payload), h.deps);
    expect(res.status).toBe(202);
    const { id } = res.body as { id: string };
    await h.settle();

    expect(start.mock.calls).toEqual([[id]]);
    expect(h.streams).toHaveLength(1);
    expect(h.fetches).toHaveLength(0);
    expect((await h.repo.getConversation(id))!.report.status).toBe("done");

    // 탭을 닫았다 열어도 status는 DB만 읽는다
    const calls = { streams: h.streams.length, counts: h.counts.length };
    const status = await handleStatus(statusOf(h.cookie, id), h.deps, id);
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ report: { status: "done", progress: null, errorCode: null }, paused: false });
    expect({ streams: h.streams.length, counts: h.counts.length }).toEqual(calls);
    expect(h.fetches).toHaveLength(0);
  });

  it("tone만 다른 같은 대화는 중복이 아니라 새 id(202). findDuplicate에 tone을 넘긴다", async () => {
    const h = await harness();
    h.state.manual = true;
    const find = vi.spyOn(h.repo, "findDuplicate");
    const fact = await handleCreateConversation(create(h.cookie, makePayload(0, "fact")), h.deps);
    const warm = await handleCreateConversation(create(h.cookie, makePayload(0, "warm")), h.deps);
    expect([fact.status, warm.status]).toEqual([202, 202]);
    expect((warm.body as { id: string }).id).not.toBe((fact.body as { id: string }).id);
    expect(find.mock.calls.map(([a]) => a.tone)).toEqual(["fact", "warm"]);
    expect(find.mock.calls[1][0]).toEqual({
      inviteId: expect.any(String),
      payloadSha256: await sha256Hex(JSON.stringify(makePayload(0, "warm"))),
      concept: "couple",
      tone: "warm",
      promptVersion: PROMPT_VERSION,
    });
    expect((await h.repo.getConversation((warm.body as { id: string }).id))!.tone).toBe("warm");
  });

  it("countTokens에는 리포트 요청의 model·system·messages·thinking·output_config만 보낸다", async () => {
    const h = await harness();
    h.state.manual = true;
    await handleCreateConversation(create(h.cookie, makePayload()), h.deps);
    expect(h.counts).toHaveLength(1);
    expect(Object.keys(h.counts[0]).sort()).toEqual(["messages", "model", "output_config", "system", "thinking"]);
    expect(JSON.stringify(h.counts[0].messages)).toContain("말투: 잔소리하는 친구");
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
    expect(h.streams).toHaveLength(1);
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
    expect(status.body).toEqual({ report: { status: "failed", progress: null, errorCode: "limit" }, paused: true });

    const claim = vi.spyOn(h.repo, "claim");
    const next = await handleCreateConversation(create(h.cookie, makePayload(1)), h.deps);
    await h.settle();
    expect(next).toEqual({ status: 423, body: { error: "paused" } });
    expect(h.counts).toHaveLength(1);
    expect(h.streams).toHaveLength(1);
    expect(h.fetches).toHaveLength(0);
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
    const h = await harness({ reply: () => cut(cutInSecondSection()), deadlineMs: 150 });
    const res = await handleCreateConversation(create(h.cookie, makePayload()), h.deps);
    await h.settle();
    const { report } = (await h.repo.getConversation((res.body as { id: string }).id))!;
    expect(report.status).toBe("partial");
    expect(report.content?.sections.map((s) => s.title)).toEqual(["저녁의 리듬"]);
  });

  it("countTokens가 예산 × 1.05를 넘으면 413 {maxTokens}: (본문+통계+프롬프트 몫) 단위. claim·생성 없음", async () => {
    const budget = inputTokenBudgetFor(DEFAULT_MODEL);
    const counted = budget * 2;
    const h = await harness({ counted: () => counted });
    const claim = vi.spyOn(h.repo, "claim");
    const payload = withTextTokens(makePayload(), 150_000);
    const total = payloadTokens(payload, TOKENS_PER_CHAR).total;
    const res = await handleCreateConversation(create(h.cookie, payload), h.deps);
    expect(res).toEqual({ status: 413, body: { maxTokens: Math.floor(((total + PROMPT_RESERVE_TOKENS) * budget) / counted) } });
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
        tone: "fact",
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
    // 만든 직후 리포트는 running이고 작업이 하나 예약된다
    const row = await h.repo.getConversation(((await claim.mock.results[0].value) as { id: string }).id);
    expect(row!.report.status).toBe("running");
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

  it("Anthropic 키(client)가 없으면 503. 가짜 클라이언트로 돌지 않는다", async () => {
    const h = await harness();
    const noClient = await handleCreateConversation(create(h.cookie, makePayload()), { ...h.deps, client: null });
    expect(noClient).toEqual({ status: 503, body: { error: "not_ready" } });
    expect(h.counts).toHaveLength(0);
  });
});
