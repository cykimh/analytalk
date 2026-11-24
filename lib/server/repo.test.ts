// memoryRepo 는 sideinfra 마이그레이션(20261123063000_analytalk_core.sql)의 규칙을 그대로 재현한다.
// 시각은 Date 만 가짜로 돌려 주기 경계·24시간·30일 창을 확인한다.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { E2E_INVITE_CODE } from "@/lib/config";
import { hashCode } from "@/lib/invite/code";
import type { Usage } from "@/lib/llm/cost";
import { type AppRepo, type ClaimResult, getRepo, memoryRepo, NotReadyError } from "./repo";

/** 서울 시각 문자열 → ms */
const kst = (local: string) => new Date(`${local}+09:00`).getTime();
const at = (local: string) => vi.setSystemTime(kst(local));

const USAGE: Usage = { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

const meta = (over: Record<string, unknown> = {}) => ({
  prompt_version: "v1",
  kind: "group",
  period_start: "2026-01-01",
  period_end: "2026-06-30",
  cutoff_at: "2026-06-30T12:00:00+09:00",
  msg_total: 1000,
  msg_sent: 800,
  display_names: ["나", "P2", "P3"],
  stats: { messages: 1000 },
  ...over,
});

let seq = 0;
function claim(
  repo: AppRepo,
  inviteId: string,
  o: { sha?: string; estCost?: number; concept?: string; meta?: Record<string, unknown> } = {},
) {
  return repo.claim({
    inviteId,
    concept: o.concept ?? "group",
    payloadSha256: o.sha ?? `sha-${++seq}`,
    meta: o.meta ?? meta(),
    estCost: o.estCost ?? 1,
  });
}

async function created(result: Promise<ClaimResult>): Promise<string> {
  const r = await result;
  expect(r.outcome).toBe("created");
  return r.id as string;
}

function finish(
  repo: AppRepo,
  id: string,
  n: number,
  status: string,
  o: { errorCode?: string | null; cost?: number; usage?: Usage | null; content?: unknown } = {},
) {
  return repo.finishEpisode({
    id,
    n,
    status,
    content: o.content ?? null,
    model: "claude-opus-5-5",
    stopReason: "end_turn",
    errorCode: o.errorCode ?? null,
    usage: "usage" in o ? (o.usage ?? null) : o.cost ? USAGE : null,
    cost: o.cost ?? 0,
  });
}

async function fixture() {
  const repo = memoryRepo({
    invites: [
      { code: "ONEONE2222", monthlyLimit: 1 },
      { code: "TWOTWO2222", monthlyLimit: 2 },
      { code: "MANY222222", monthlyLimit: 99 },
      { code: "GONE222222", monthlyLimit: 2, revoked: true },
    ],
  });
  const id = async (code: string) => (await repo.findInvite(hashCode(code)))!.id;
  return { repo, one: await id("ONEONE2222"), two: await id("TWOTWO2222"), many: await id("MANY222222"), gone: await id("GONE222222") };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // 주기(매월 1일 시작)의 마지막 날: 남은 날짜가 1일이라 일간 한도가 넉넉하다
  at("2026-11-30T10:00:00");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("memoryRepo 초대 코드", () => {
  it("코드 해시로 찾고, id로 한도와 폐기 여부를 읽는다", async () => {
    const { repo, two } = await fixture();
    expect(await repo.findInvite(hashCode(" twotwo2222 "))).toEqual({ id: two, revoked: false });
    expect(await repo.getInvite(two)).toEqual({ id: two, revoked: false, monthlyLimit: 2 });
    expect(await repo.findInvite(hashCode("GONE222222"))).toMatchObject({ revoked: true });
    expect(await repo.findInvite(hashCode("NONE222222"))).toBeNull();
    expect(await repo.getInvite(randomUUID())).toBeNull();
    expect(await repo.ping()).toBe(true);
  });
});

describe("memoryRepo claim 판정 순서", () => {
  it("같은 요청을 두 번 claim하면 두 번째는 duplicate·같은 id다. 월 1건 코드도 한도보다 중복을 먼저 본다", async () => {
    const { repo, one } = await fixture();
    const first = await claim(repo, one, { sha: "same" });
    expect(first.outcome).toBe("created");
    expect(await claim(repo, one, { sha: "same" })).toEqual({ id: first.id, outcome: "duplicate" });
    expect(await repo.findDuplicate({ inviteId: one, payloadSha256: "same", concept: "group", promptVersion: "v1" })).toBe(first.id);
  });

  it("코드·컨셉·프롬프트 버전·payload 중 하나라도 다르면 중복이 아니다", async () => {
    const { repo, one, two } = await fixture();
    await created(claim(repo, one, { sha: "same" }));
    const base = { inviteId: one, payloadSha256: "same", concept: "group", promptVersion: "v1" };
    expect(await repo.findDuplicate({ ...base, inviteId: two })).toBeNull();
    expect(await repo.findDuplicate({ ...base, concept: "couple" })).toBeNull();
    expect(await repo.findDuplicate({ ...base, promptVersion: "v2" })).toBeNull();
    expect(await repo.findDuplicate({ ...base, payloadSha256: "other" })).toBeNull();
  });

  it("월 2건 코드의 세 번째는 invite_limit", async () => {
    const { repo, two } = await fixture();
    await created(claim(repo, two));
    await created(claim(repo, two));
    expect(await claim(repo, two)).toEqual({ id: null, outcome: "invite_limit" });
  });

  it("없는 코드와 폐기된 코드는 revoked", async () => {
    const { repo, gone } = await fixture();
    expect(await claim(repo, randomUUID())).toEqual({ id: null, outcome: "revoked" });
    expect(await claim(repo, gone)).toEqual({ id: null, outcome: "revoked" });
  });

  it("정지 중이면 paused. 중복 확인이 정지보다 먼저고, 정지 시각이 지나면 다시 받는다", async () => {
    const { repo, many } = await fixture();
    const first = await created(claim(repo, many, { sha: "same" }));
    await repo.setPaused(new Date(kst("2026-11-30T11:00:00")));
    expect(await claim(repo, many, { sha: "same" })).toEqual({ id: first, outcome: "duplicate" });
    expect(await claim(repo, many)).toEqual({ id: null, outcome: "paused" });
    at("2026-11-30T11:00:01");
    await created(claim(repo, many));
  });

  it("추정 원가가 없거나 0 이하면 거부한다", async () => {
    const { repo, many } = await fixture();
    for (const estCost of [0, -1, Number.NaN]) await expect(claim(repo, many, { estCost })).rejects.toThrow();
  });

  it("display_names·stats·prompt_version이 없으면 거부하고 아무것도 만들지 않는다", async () => {
    const { repo, one } = await fixture();
    for (const key of ["display_names", "stats", "prompt_version"]) {
      await expect(claim(repo, one, { meta: meta({ [key]: null }) })).rejects.toThrow();
    }
    await created(claim(repo, one));
  });

  it("만든 대화는 메타와 queued 4편을 갖고 30일 뒤 만료된다", async () => {
    const { repo, many } = await fixture();
    const id = await created(claim(repo, many, { sha: "abc", concept: "couple", meta: meta({ kind: "pair" }) }));
    expect(await repo.getConversation(id)).toEqual({
      id,
      inviteId: many,
      concept: "couple",
      kind: "pair",
      periodStart: "2026-01-01",
      periodEnd: "2026-06-30",
      cutoffAt: "2026-06-30T03:00:00.000Z",
      msgTotal: 1000,
      msgSent: 800,
      displayNames: ["나", "P2", "P3"],
      stats: { messages: 1000 },
      payloadSha256: "abc",
      shareTokenHash: null,
      shareScope: null,
      shareHidden: [],
      expiresAt: new Date(kst("2026-12-30T10:00:00")).toISOString(),
      episodes: [1, 2, 3, 4].map((n) => ({ n, status: "queued", content: null, progress: null, errorCode: null, finishedAt: null })),
    });
  });

  it("만료된 대화는 읽히지 않고 중복으로도 보지 않는다", async () => {
    const { repo, many } = await fixture();
    const id = await created(claim(repo, many, { sha: "same" }));
    at("2026-12-30T10:00:00");
    expect(await repo.getConversation(id)).toBeNull();
    expect(await repo.findDuplicate({ inviteId: many, payloadSha256: "same", concept: "group", promptVersion: "v1" })).toBeNull();
    expect(await created(claim(repo, many, { sha: "same" }))).not.toBe(id);
  });
});

describe("memoryRepo claim 원장 (Task 2 claims)", () => {
  it("대화를 지워도 원장 행은 남는다: 월 1건 코드로 claim → 삭제 → claim은 invite_limit (같은 payload여도)", async () => {
    const { repo, one } = await fixture();
    const id = await created(claim(repo, one, { sha: "same" }));
    expect(await repo.deleteConversation(id, one)).toBe(true);
    expect(await claim(repo, one, { sha: "same" })).toEqual({ id: null, outcome: "invite_limit" });
    expect(await claim(repo, one)).toEqual({ id: null, outcome: "invite_limit" });
  });

  it("1편이 refused인 대화는 세지 않는다", async () => {
    const { repo, one } = await fixture();
    const id = await created(claim(repo, one));
    await finish(repo, id, 1, "refused");
    await created(claim(repo, one));
  });

  it("2편 refused는 센다", async () => {
    const { repo, one } = await fixture();
    const id = await created(claim(repo, one));
    await finish(repo, id, 2, "refused");
    expect((await claim(repo, one)).outcome).toBe("invite_limit");
  });

  it("어느 편이든 limit 오류가 있으면 세지 않는다", async () => {
    const { repo, one } = await fixture();
    const id = await created(claim(repo, one));
    await finish(repo, id, 3, "failed", { errorCode: "limit" });
    await created(claim(repo, one));
  });

  it("limit 오류 편을 다시 쓰기 시작하면 다시 센다", async () => {
    const { repo, one } = await fixture();
    const id = await created(claim(repo, one));
    await finish(repo, id, 3, "failed", { errorCode: "limit" });
    expect(await repo.startEpisode(id, 3)).toBe(true);
    expect((await claim(repo, one)).outcome).toBe("invite_limit");
  });

  it("세지 않던 대화는 지운 뒤에도 세지 않는다", async () => {
    const { repo, one } = await fixture();
    const id = await created(claim(repo, one));
    await finish(repo, id, 1, "refused");
    await repo.deleteConversation(id, one);
    await created(claim(repo, one));
  });

  it("지난 주기의 원장 행은 세지 않는다 (주기는 서울 자정에 바뀐다)", async () => {
    const { repo, one } = await fixture();
    at("2026-10-31T23:00:00");
    await created(claim(repo, one));
    at("2026-10-31T23:59:59");
    expect((await claim(repo, one)).outcome).toBe("invite_limit");
    at("2026-11-01T00:00:00"); // UTC로는 아직 10월 31일 15시
    await created(claim(repo, one));
  });

  it("오늘 건수는 원장으로 센다: 오늘 만든 대화를 지워도 daily_limit이 풀리지 않는다", async () => {
    const { repo, many } = await fixture();
    // 주기 초에 88달러를 써 둔다(7일 전이라 주간 차단에는 안 잡힌다)
    at("2026-11-01T10:00:00");
    const early = await created(claim(repo, many));
    await finish(repo, early, 1, "done", { cost: 88 });
    for (const n of [2, 3, 4]) await finish(repo, early, n, "done");

    // 마지막 날: 남은 예산 2달러 ÷ 1일 ÷ 1달러 → 하루 2건
    at("2026-11-30T10:00:00");
    const a = await created(claim(repo, many));
    await finish(repo, a, 1, "failed", { errorCode: "overloaded" });
    const b = await created(claim(repo, many));
    await finish(repo, b, 1, "failed", { errorCode: "overloaded" });
    expect(await claim(repo, many)).toEqual({ id: null, outcome: "daily_limit" });

    await repo.deleteConversation(a, many);
    await repo.deleteConversation(b, many);
    expect(await claim(repo, many)).toEqual({ id: null, outcome: "daily_limit" });
  });

  it("하루 건수의 남은 예산에서 진행 중 대화의 예약을 뺀다", async () => {
    const { repo, many } = await fixture();
    at("2026-11-01T10:00:00");
    const early = await created(claim(repo, many));
    await finish(repo, early, 1, "done", { cost: 88 });
    for (const n of [2, 3, 4]) await finish(repo, early, n, "done");
    at("2026-11-30T10:00:00");
    // 진행 중 1건(1달러 예약) → (2 − 1) ÷ 1일 ÷ 1달러 = 1건, 오늘 이미 1건
    await created(claim(repo, many));
    expect((await claim(repo, many)).outcome).toBe("daily_limit");
  });

  it("어제(서울 날짜) 원장 행은 오늘 건수에 들지 않는다", async () => {
    const { repo, many } = await fixture();
    at("2026-11-01T10:00:00");
    const early = await created(claim(repo, many));
    await finish(repo, early, 1, "done", { cost: 86 });
    for (const n of [2, 3, 4]) await finish(repo, early, n, "done");
    const failedClaim = async () => {
      const id = await created(claim(repo, many));
      await finish(repo, id, 1, "failed", { errorCode: "overloaded" });
    };
    // 29일 23시(UTC로는 같은 날 14시): 남은 예산 4달러 ÷ 2일 → 하루 2건
    at("2026-11-29T23:00:00");
    await failedClaim();
    await failedClaim();
    // 30일 0시(UTC로는 아직 29일): 남은 예산 4달러 ÷ 1일 → 하루 4건. 어제 2건을 세면 2건만 된다
    at("2026-11-30T00:00:00");
    for (let i = 0; i < 4; i++) await failedClaim();
    expect((await claim(repo, many)).outcome).toBe("daily_limit");
  });
});

// 주간 차단 22.5달러, 추정 원가 10달러: 진행 중 대화가 2건이면 다음 요청(3 × 10)이 막히고 1건이면 통과한다
describe("memoryRepo 진행 중 대화 (주간 차단의 예약)", () => {
  const EST = 10;

  it("방금 만든 대화 두 건이 진행 중이면 세 번째는 global_limit", async () => {
    const { repo, many } = await fixture();
    await created(claim(repo, many, { estCost: EST }));
    await created(claim(repo, many, { estCost: EST }));
    expect(await claim(repo, many, { estCost: EST })).toEqual({ id: null, outcome: "global_limit" });
  });

  it("주간 차단은 22.5달러를 넘을 때만 막는다(같으면 통과)", async () => {
    const { repo, many } = await fixture();
    for (let i = 0; i < 3; i++) await created(claim(repo, many, { estCost: 7.5 }));
    expect((await claim(repo, many, { estCost: 7.5 })).outcome).toBe("global_limit");
  });

  it("1편 failed + 2~4편 queued인 대화는 예약하지 않는다", async () => {
    const { repo, many } = await fixture();
    const a = await created(claim(repo, many, { estCost: EST }));
    await created(claim(repo, many, { estCost: EST }));
    await finish(repo, a, 1, "failed", { errorCode: "overloaded" });
    await created(claim(repo, many, { estCost: EST }));
  });

  const cases: [string, (repo: AppRepo, id: string) => Promise<unknown>, boolean][] = [
    ["1편 queued 그대로(24시간 지남)", async () => {}, false],
    ["1편 running", (repo, id) => repo.startEpisode(id, 1), true],
    ["1편 done + 2~4편 queued", (repo, id) => finish(repo, id, 1, "done"), true],
    ["1편 partial + 2~4편 queued", (repo, id) => finish(repo, id, 1, "partial"), true],
    [
      "1편 done + 2편 running",
      async (repo, id) => {
        await finish(repo, id, 1, "done");
        await repo.startEpisode(id, 2);
      },
      true,
    ],
    ["1편 failed", (repo, id) => finish(repo, id, 1, "failed", { errorCode: "overloaded" }), false],
    ["1편 refused", (repo, id) => finish(repo, id, 1, "refused"), false],
    ["1편 safety", (repo, id) => finish(repo, id, 1, "safety"), false],
    [
      "4편 모두 끝남",
      async (repo, id) => {
        for (const n of [1, 2, 3, 4]) await finish(repo, id, n, "done");
      },
      false,
    ],
  ];

  it.each(cases)("어제 만든 대화가 %s → 예약 %s", async (_label, act, reserved) => {
    const { repo, many } = await fixture();
    at("2026-11-29T09:00:00");
    const a = await created(claim(repo, many, { estCost: EST }));
    at("2026-11-30T10:00:00");
    await act(repo, a);
    await created(claim(repo, many, { estCost: EST }));
    expect((await claim(repo, many, { estCost: EST })).outcome).toBe(reserved ? "global_limit" : "created");
  });

  it("만료된 대화는 running이어도 예약하지 않는다", async () => {
    const { repo, many } = await fixture();
    at("2026-10-30T10:00:00");
    const a = await created(claim(repo, many, { estCost: EST }));
    at("2026-11-30T10:00:00");
    expect(await repo.startEpisode(a, 1)).toBe(true);
    await created(claim(repo, many, { estCost: EST }));
    await created(claim(repo, many, { estCost: EST }));
  });

  it("최근 7일 원가를 더한다. 지운 대화에서 나중에 끝난 편의 원가도 남는다", async () => {
    const { repo, many } = await fixture();
    at("2026-11-23T10:00:00");
    const a = await created(claim(repo, many, { estCost: EST }));
    await repo.startEpisode(a, 1);
    await repo.deleteConversation(a, many);
    await finish(repo, a, 1, "done", { cost: 15 });
    // 15 + (0 + 1) × 10 = 25 > 22.5
    expect((await claim(repo, many, { estCost: EST })).outcome).toBe("global_limit");
    at("2026-11-30T09:59:59");
    expect((await claim(repo, many, { estCost: EST })).outcome).toBe("global_limit");
    // 정확히 7일이 지나면 창 밖이다 (at > now − 7일)
    at("2026-11-30T10:00:00");
    await created(claim(repo, many, { estCost: EST }));
  });

  it("usage가 null이면 원가를 남기지 않는다", async () => {
    const { repo, many } = await fixture();
    const a = await created(claim(repo, many, { estCost: EST }));
    await finish(repo, a, 1, "failed", { cost: 15, usage: null });
    await created(claim(repo, many, { estCost: EST }));
  });
});

describe("memoryRepo 평균 원가", () => {
  /** days마다 대화 하나를 만들고 1편 원가 20달러로 4편을 끝낸다. 4편 상태는 last */
  async function seedFinished(repo: AppRepo, inviteId: string, days: string[], last = "done", cost = 20) {
    for (const day of days) {
      at(`${day}T10:00:00`);
      const id = await created(claim(repo, inviteId));
      await finish(repo, id, 1, "done", { cost, usage: USAGE });
      await finish(repo, id, 2, "done");
      await finish(repo, id, 3, "done");
      await finish(repo, id, 4, last);
    }
    at("2026-11-30T10:00:00");
  }
  // 7일보다 오래돼 주간 원가에는 안 잡히고, 30일 안이라 표본이 된다
  const DAYS = ["2026-11-01", "2026-11-09", "2026-11-17"];

  it("최근 30일에 4편이 다 끝난 대화가 3건 이상이면 그 평균(20달러)으로 예약한다", async () => {
    const { repo, many } = await fixture();
    await seedFinished(repo, many, DAYS);
    await created(claim(repo, many, { estCost: 1 }));
    // 0 + (1 + 1) × 20 = 40 > 22.5. 추정 원가(1달러)였다면 통과했다
    expect((await claim(repo, many, { estCost: 1 })).outcome).toBe("global_limit");
  });

  it.each(["refused", "safety", "partial"])("4편이 %s여도 끝난 대화로 센다", async (last) => {
    const { repo, many } = await fixture();
    await seedFinished(repo, many, DAYS, last);
    await created(claim(repo, many, { estCost: 1 }));
    expect((await claim(repo, many, { estCost: 1 })).outcome).toBe("global_limit");
  });

  it("표본이 3건 미만이면 추정 원가로 예약한다", async () => {
    const { repo, many } = await fixture();
    await seedFinished(repo, many, DAYS.slice(1));
    await created(claim(repo, many, { estCost: 1 }));
    await created(claim(repo, many, { estCost: 1 }));
  });

  it("failed 편이 있는 대화는 표본이 아니다", async () => {
    const { repo, many } = await fixture();
    await seedFinished(repo, many, DAYS.slice(0, 1), "failed");
    await seedFinished(repo, many, DAYS.slice(1));
    await created(claim(repo, many, { estCost: 1 }));
    await created(claim(repo, many, { estCost: 1 }));
  });

  it("30일보다 오래된 대화는 표본이 아니다", async () => {
    const { repo, many } = await fixture();
    await seedFinished(repo, many, ["2026-10-30", ...DAYS.slice(1)]);
    await created(claim(repo, many, { estCost: 1 }));
    await created(claim(repo, many, { estCost: 1 }));
  });

  it("표본 평균이 0이면 추정 원가로 예약한다", async () => {
    const { repo, many } = await fixture();
    await seedFinished(repo, many, DAYS, "done", 0);
    await created(claim(repo, many, { estCost: 10 }));
    await created(claim(repo, many, { estCost: 10 }));
    expect((await claim(repo, many, { estCost: 10 })).outcome).toBe("global_limit");
  });
});

describe("memoryRepo 편 상태 (Task 2 start_episode·save_progress·finish_episode)", () => {
  it.each([
    ["queued", true],
    ["failed", true],
    ["partial", true],
    ["running", false],
    ["done", false],
    ["refused", false],
    ["safety", false],
  ])("%s 편을 시작하면 %s", async (status, ok) => {
    const { repo, many } = await fixture();
    const id = await created(claim(repo, many));
    if (status === "running") await repo.startEpisode(id, 2);
    else if (status !== "queued") await finish(repo, id, 2, status);
    expect(await repo.startEpisode(id, 2)).toBe(ok);
    expect((await repo.getConversation(id))!.episodes[1].status).toBe(ok ? "running" : status);
  });

  it("시작하면 error_code·progress·finished_at을 비우고 content는 둔다", async () => {
    const { repo, many } = await fixture();
    const id = await created(claim(repo, many));
    await repo.startEpisode(id, 1);
    await repo.saveProgress(id, 1, [{ range: "01-01~01-31", note: "읽는 중" }]);
    await finish(repo, id, 1, "partial", { errorCode: "timeout", content: { headline: "첫 편" } });
    expect(await repo.startEpisode(id, 1)).toBe(true);
    expect((await repo.getConversation(id))!.episodes[0]).toEqual({
      n: 1,
      status: "running",
      content: { headline: "첫 편" },
      progress: null,
      errorCode: null,
      finishedAt: null,
    });
  });

  it("없는 대화나 편은 시작하지 않는다", async () => {
    const { repo, many } = await fixture();
    const id = await created(claim(repo, many));
    expect(await repo.startEpisode(randomUUID(), 1)).toBe(false);
    expect(await repo.startEpisode(id, 5)).toBe(false);
    expect(await repo.startEpisode("not-a-uuid", 1)).toBe(false);
  });

  it("saveProgress는 running 편에만 쓴다", async () => {
    const { repo, many } = await fixture();
    const id = await created(claim(repo, many));
    const notes = [{ range: "01-01~01-31", note: "읽는 중" }];
    await repo.saveProgress(id, 1, notes);
    expect((await repo.getConversation(id))!.episodes[0].progress).toBeNull();
    await repo.startEpisode(id, 1);
    await repo.saveProgress(id, 1, notes);
    expect((await repo.getConversation(id))!.episodes[0].progress).toEqual(notes);
    await finish(repo, id, 1, "done");
    await repo.saveProgress(id, 1, [{ range: "02-01~02-28", note: "늦게 온 메모" }]);
    expect((await repo.getConversation(id))!.episodes[0].progress).toEqual(notes);
  });

  it("finishEpisode는 지금 상태와 상관없이 덮어쓰고 끝난 시각을 남긴다", async () => {
    const { repo, many } = await fixture();
    const id = await created(claim(repo, many));
    await finish(repo, id, 3, "failed", { errorCode: "dispatch" });
    expect((await repo.getConversation(id))!.episodes[2]).toMatchObject({
      status: "failed",
      errorCode: "dispatch",
      finishedAt: new Date(kst("2026-11-30T10:00:00")).toISOString(),
    });
  });

  it("모르는 상태로는 끝내지 않는다", async () => {
    const { repo, many } = await fixture();
    const id = await created(claim(repo, many));
    await expect(finish(repo, id, 1, "bogus")).rejects.toThrow();
    expect((await repo.getConversation(id))!.episodes[0].status).toBe("queued");
  });
});

describe("memoryRepo 삭제·공유·피드백", () => {
  it("다른 코드로는 지우지 못하고, 같은 코드로 지우면 사라진다", async () => {
    const { repo, many, two } = await fixture();
    const id = await created(claim(repo, many));
    expect(await repo.deleteConversation(id, two)).toBe(false);
    expect(await repo.getConversation(id)).not.toBeNull();
    expect(await repo.deleteConversation(id, many)).toBe(true);
    expect(await repo.getConversation(id)).toBeNull();
    expect(await repo.deleteConversation(id, many)).toBe(false);
  });

  it("공유는 같은 코드만 설정하고, 토큰 해시로 읽고, null로 끈다", async () => {
    const { repo, many, two } = await fixture();
    const id = await created(claim(repo, many));
    const share = { tokenHash: "hash-1", scope: "first" as const, hidden: [3] };
    expect(await repo.setShare(id, two, share)).toBe(false);
    expect(await repo.getByShareHash("hash-1")).toBeNull();
    expect(await repo.setShare(id, many, share)).toBe(true);
    expect(await repo.getByShareHash("hash-1")).toMatchObject({ id, shareTokenHash: "hash-1", shareScope: "first", shareHidden: [3] });
    expect(await repo.setShare(id, many, { tokenHash: null, scope: "all", hidden: [] })).toBe(true);
    expect(await repo.getByShareHash("hash-1")).toBeNull();
    expect(await repo.getConversation(id)).toMatchObject({ shareTokenHash: null, shareScope: "all", shareHidden: [] });
  });

  it("만료된 대화는 공유 링크로도 읽히지 않는다", async () => {
    const { repo, many } = await fixture();
    const id = await created(claim(repo, many));
    await repo.setShare(id, many, { tokenHash: "hash-1", scope: "all", hidden: [] });
    at("2026-12-30T10:00:00");
    expect(await repo.getByShareHash("hash-1")).toBeNull();
  });

  it("같은 공유 토큰 해시를 두 대화에 줄 수 없다", async () => {
    const { repo, many } = await fixture();
    const a = await created(claim(repo, many));
    const b = await created(claim(repo, many));
    await repo.setShare(a, many, { tokenHash: "hash-1", scope: "all", hidden: [] });
    await expect(repo.setShare(b, many, { tokenHash: "hash-1", scope: "all", hidden: [] })).rejects.toThrow();
  });

  it("피드백은 정해진 이유로, 있는 대화에만 남긴다", async () => {
    const { repo, many } = await fixture();
    const id = await created(claim(repo, many));
    await expect(repo.addFeedback({ id, n: 1, paragraphKey: "s1p1", reason: "tone" })).resolves.toBeUndefined();
    await expect(repo.addFeedback({ id, n: 1, paragraphKey: "s1p1", reason: "boring" })).rejects.toThrow();
    await expect(repo.addFeedback({ id: randomUUID(), n: 1, paragraphKey: "s1p1", reason: "tone" })).rejects.toThrow();
  });

  it("돌려준 값을 고쳐도 저장된 값은 그대로다", async () => {
    const { repo, many } = await fixture();
    const id = await created(claim(repo, many));
    const row = (await repo.getConversation(id))!;
    row.displayNames.push("X");
    row.episodes[0].status = "done";
    expect((await repo.getConversation(id))!.displayNames).toEqual(["나", "P2", "P3"]);
    expect((await repo.getConversation(id))!.episodes[0].status).toBe("queued");
  });
});

describe("getRepo", () => {
  const g = globalThis as { analytalkRepoV1?: AppRepo; analytalkDevRepoV1?: AppRepo };
  afterEach(() => {
    delete g.analytalkRepoV1;
    delete g.analytalkDevRepoV1;
  });

  it("E2E 모드는 키가 있어도 고정 초대 코드(월 99건)가 든 memoryRepo를 전역에 하나 둔다", async () => {
    vi.stubEnv("ANALYTALK_E2E", "1");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_test");
    const repo = getRepo();
    expect(getRepo()).toBe(repo);
    expect(g.analytalkRepoV1).toBe(repo);
    const invite = await repo.findInvite(hashCode(E2E_INVITE_CODE));
    expect(await repo.getInvite(invite!.id)).toMatchObject({ revoked: false, monthlyLimit: 99 });
  });

  it("개발에서 키가 없으면 코드가 없는 memoryRepo", async () => {
    vi.stubEnv("ANALYTALK_E2E", "");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    const repo = getRepo();
    expect(getRepo()).toBe(repo);
    expect(await repo.findInvite(hashCode(E2E_INVITE_CODE))).toBeNull();
  });

  it("프로덕션에서 키가 없으면 503 오류를 던진다", () => {
    vi.stubEnv("ANALYTALK_E2E", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    expect(() => getRepo()).toThrow(NotReadyError);
    try {
      getRepo();
    } catch (error) {
      expect((error as NotReadyError).status).toBe(503);
    }
  });

  it("키가 있으면 secret 키로 analytalk 스키마의 Supabase에 묻는다", async () => {
    vi.stubEnv("ANALYTALK_E2E", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_test");
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json("ok"));
    vi.stubGlobal("fetch", fetch);
    expect(await getRepo().ping()).toBe(true);
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:54321/rest/v1/rpc/healthcheck");
    const headers = new Headers(init?.headers);
    expect(headers.get("apikey")).toBe("sb_secret_test");
    expect(headers.get("content-profile") ?? headers.get("accept-profile")).toBe("analytalk");
  });
});
