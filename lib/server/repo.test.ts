// memoryRepo 는 sideinfra 마이그레이션(20261123063000_analytalk_core.sql + 20261126090000_analytalk_v2.sql)의 규칙을 그대로 재현한다.
// v2: 대화당 리포트 한 행(episodes n = 1), 중복 키에 tone.
// 시각은 Date 만 가짜로 돌려 주기 경계·24시간·30일 창을 확인한다.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { E2E_INVITE_CODE } from "@/lib/config";
import { hashCode } from "@/lib/invite/code";
import type { Usage } from "@/lib/llm/cost";
import { type AppRepo, type ClaimResult, getRepo, isPaused, memoryRepo, NotReadyError } from "./repo";

/** 서울 시각 문자열 → ms */
const kst = (local: string) => new Date(`${local}+09:00`).getTime();
const at = (local: string) => vi.setSystemTime(kst(local));

const USAGE: Usage = { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

const meta = (over: Record<string, unknown> = {}) => ({
  prompt_version: "v1",
  tone: "fact",
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
  status: string,
  o: { errorCode?: string | null; cost?: number; usage?: Usage | null; content?: unknown } = {},
) {
  return repo.finishReport({
    id,
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
    expect(await repo.findDuplicate({ inviteId: one, payloadSha256: "same", concept: "group", tone: "fact", promptVersion: "v1" })).toBe(first.id);
  });

  it("코드·컨셉·말투·프롬프트 버전·payload 중 하나라도 다르면 중복이 아니다", async () => {
    const { repo, one, two } = await fixture();
    await created(claim(repo, one, { sha: "same" }));
    const base = { inviteId: one, payloadSha256: "same", concept: "group", tone: "fact", promptVersion: "v1" };
    expect(await repo.findDuplicate(base)).not.toBeNull();
    expect(await repo.findDuplicate({ ...base, inviteId: two })).toBeNull();
    expect(await repo.findDuplicate({ ...base, concept: "couple" })).toBeNull();
    expect(await repo.findDuplicate({ ...base, tone: "warm" })).toBeNull();
    expect(await repo.findDuplicate({ ...base, promptVersion: "v2" })).toBeNull();
    expect(await repo.findDuplicate({ ...base, payloadSha256: "other" })).toBeNull();
  });

  it("claim도 p_meta의 tone으로 중복을 본다: 같은 sha·다른 tone은 새 대화", async () => {
    const { repo, two } = await fixture();
    const fact = await created(claim(repo, two, { sha: "same" }));
    const warm = await created(claim(repo, two, { sha: "same", meta: meta({ tone: "warm" }) }));
    expect(warm).not.toBe(fact);
    expect((await repo.getConversation(warm))!.tone).toBe("warm");
    expect(await claim(repo, two, { sha: "same", meta: meta({ tone: "warm" }) })).toEqual({ id: warm, outcome: "duplicate" });
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

  it("getPausedUntil은 setPaused로 건 시각(없으면 null)을 돌려준다. isPaused는 그 시각 > now", async () => {
    const repo = memoryRepo();
    expect(await repo.getPausedUntil()).toBeNull();
    expect(await isPaused(repo, kst("2026-11-30T11:00:00"))).toBe(false);
    const until = new Date(kst("2026-11-30T11:00:00"));
    await repo.setPaused(until);
    const got = await repo.getPausedUntil();
    expect(got).toEqual(until);
    // 돌려준 Date를 바꿔도 저장소 값은 그대로다
    got!.setTime(0);
    expect(await repo.getPausedUntil()).toEqual(until);
    // claim_conversation과 같이 paused_until > now()
    expect(await isPaused(repo, kst("2026-11-30T10:59:59"))).toBe(true);
    expect(await isPaused(repo, kst("2026-11-30T11:00:00"))).toBe(false);
  });

  it("추정 원가가 없거나 0 이하면 거부한다", async () => {
    const { repo, many } = await fixture();
    for (const estCost of [0, -1, Number.NaN]) await expect(claim(repo, many, { estCost })).rejects.toThrow();
  });

  it("display_names·stats·prompt_version·tone이 없거나 tone이 fact·warm·show 밖이면 거부하고 아무것도 만들지 않는다", async () => {
    const { repo, one } = await fixture();
    for (const key of ["display_names", "stats", "prompt_version", "tone"]) {
      await expect(claim(repo, one, { meta: meta({ [key]: null }) })).rejects.toThrow();
    }
    const { tone: _, ...noTone } = meta();
    await expect(claim(repo, one, { meta: noTone })).rejects.toThrow("[memoryRepo] tone check");
    await expect(claim(repo, one, { meta: meta({ tone: "loud" }) })).rejects.toThrow("[memoryRepo] tone check");
    await created(claim(repo, one));
  });

  it("만든 대화는 메타와 queued 리포트 한 행을 갖고 30일 뒤 만료된다", async () => {
    const { repo, many } = await fixture();
    const id = await created(claim(repo, many, { sha: "abc", concept: "couple", meta: meta({ kind: "pair", tone: "show" }) }));
    expect(await repo.getConversation(id)).toEqual({
      id,
      inviteId: many,
      concept: "couple",
      tone: "show",
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
      expiresAt: new Date(kst("2026-12-30T10:00:00")).toISOString(),
      report: { status: "queued", content: null, progress: null, errorCode: null },
    });
  });

  it("만료된 대화는 읽히지 않고 중복으로도 보지 않는다", async () => {
    const { repo, many } = await fixture();
    const id = await created(claim(repo, many, { sha: "same" }));
    at("2026-12-30T10:00:00");
    expect(await repo.getConversation(id)).toBeNull();
    expect(await repo.findDuplicate({ inviteId: many, payloadSha256: "same", concept: "group", tone: "fact", promptVersion: "v1" })).toBeNull();
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

  it("리포트가 refused인 대화는 세지 않는다", async () => {
    const { repo, one } = await fixture();
    const id = await created(claim(repo, one));
    await finish(repo, id, "refused");
    await created(claim(repo, one));
  });

  it("리포트에 limit 오류가 있으면 세지 않는다", async () => {
    const { repo, one } = await fixture();
    const id = await created(claim(repo, one));
    await finish(repo, id, "failed", { errorCode: "limit" });
    await created(claim(repo, one));
  });

  it("limit 오류 리포트를 다시 쓰기 시작하면 다시 센다", async () => {
    const { repo, one } = await fixture();
    const id = await created(claim(repo, one));
    await finish(repo, id, "failed", { errorCode: "limit" });
    expect(await repo.startReport(id)).toBe(true);
    expect((await claim(repo, one)).outcome).toBe("invite_limit");
  });

  it("세지 않던 대화는 지운 뒤에도 세지 않는다", async () => {
    const { repo, one } = await fixture();
    const id = await created(claim(repo, one));
    await finish(repo, id, "refused");
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
    await finish(repo, early, "done", { cost: 88 });

    // 마지막 날: 남은 예산 2달러 ÷ 1일 ÷ 1달러 → 하루 2건
    at("2026-11-30T10:00:00");
    const a = await created(claim(repo, many));
    await finish(repo, a, "failed", { errorCode: "overloaded" });
    const b = await created(claim(repo, many));
    await finish(repo, b, "failed", { errorCode: "overloaded" });
    expect(await claim(repo, many)).toEqual({ id: null, outcome: "daily_limit" });

    await repo.deleteConversation(a, many);
    await repo.deleteConversation(b, many);
    expect(await claim(repo, many)).toEqual({ id: null, outcome: "daily_limit" });
  });

  it("하루 건수의 남은 예산에서 진행 중 대화의 예약을 뺀다", async () => {
    const { repo, many } = await fixture();
    at("2026-11-01T10:00:00");
    const early = await created(claim(repo, many));
    await finish(repo, early, "done", { cost: 88 });
    at("2026-11-30T10:00:00");
    // 진행 중 1건(1달러 예약) → (2 − 1) ÷ 1일 ÷ 1달러 = 1건, 오늘 이미 1건
    await created(claim(repo, many));
    expect((await claim(repo, many)).outcome).toBe("daily_limit");
  });

  it("어제(서울 날짜) 원장 행은 오늘 건수에 들지 않는다", async () => {
    const { repo, many } = await fixture();
    at("2026-11-01T10:00:00");
    const early = await created(claim(repo, many));
    await finish(repo, early, "done", { cost: 86 });
    const failedClaim = async () => {
      const id = await created(claim(repo, many));
      await finish(repo, id, "failed", { errorCode: "overloaded" });
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

  it("failed 리포트는 예약하지 않는다", async () => {
    const { repo, many } = await fixture();
    const a = await created(claim(repo, many, { estCost: EST }));
    await created(claim(repo, many, { estCost: EST }));
    await finish(repo, a, "failed", { errorCode: "overloaded" });
    await created(claim(repo, many, { estCost: EST }));
  });

  const cases: [string, (repo: AppRepo, id: string) => Promise<unknown>, boolean][] = [
    ["queued 그대로(24시간 지남)", async () => {}, false],
    ["running", (repo, id) => repo.startReport(id), true],
    ["done", (repo, id) => finish(repo, id, "done"), false],
    ["partial", (repo, id) => finish(repo, id, "partial"), false],
    ["failed", (repo, id) => finish(repo, id, "failed", { errorCode: "overloaded" }), false],
    ["refused", (repo, id) => finish(repo, id, "refused"), false],
    ["safety", (repo, id) => finish(repo, id, "safety"), false],
  ];

  it.each(cases)("어제 만든 대화의 리포트가 %s → 예약 %s", async (_label, act, reserved) => {
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
    expect(await repo.startReport(a)).toBe(true);
    await created(claim(repo, many, { estCost: EST }));
    await created(claim(repo, many, { estCost: EST }));
  });

  it("최근 7일 원가를 더한다. 지운 대화에서 나중에 끝난 리포트의 원가도 남는다", async () => {
    const { repo, many } = await fixture();
    at("2026-11-23T10:00:00");
    const a = await created(claim(repo, many, { estCost: EST }));
    await repo.startReport(a);
    await repo.deleteConversation(a, many);
    await finish(repo, a, "done", { cost: 15 });
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
    await finish(repo, a, "failed", { cost: 15, usage: null });
    await created(claim(repo, many, { estCost: EST }));
  });
});

describe("memoryRepo 평균 원가", () => {
  /** days마다 대화 하나를 만들고 원가 cost달러로 리포트를 status로 끝낸다 */
  async function seedFinished(repo: AppRepo, inviteId: string, days: string[], status = "done", cost = 20) {
    for (const day of days) {
      at(`${day}T10:00:00`);
      const id = await created(claim(repo, inviteId));
      await finish(repo, id, status, { cost, usage: USAGE });
    }
    at("2026-11-30T10:00:00");
  }
  // 7일보다 오래돼 주간 원가에는 안 잡히고, 30일 안이라 표본이 된다
  const DAYS = ["2026-11-01", "2026-11-09", "2026-11-17"];

  it("최근 30일에 리포트가 끝난 대화가 3건 이상이면 그 평균(20달러)으로 예약한다", async () => {
    const { repo, many } = await fixture();
    await seedFinished(repo, many, DAYS);
    await created(claim(repo, many, { estCost: 1 }));
    // 0 + (1 + 1) × 20 = 40 > 22.5. 추정 원가(1달러)였다면 통과했다
    expect((await claim(repo, many, { estCost: 1 })).outcome).toBe("global_limit");
  });

  it.each(["done", "partial", "refused", "safety"])("리포트가 %s면 끝난 대화로 센다", async (status) => {
    const { repo, many } = await fixture();
    await seedFinished(repo, many, DAYS, status);
    await created(claim(repo, many, { estCost: 1 }));
    expect((await claim(repo, many, { estCost: 1 })).outcome).toBe("global_limit");
  });

  it("표본이 3건 미만이면 추정 원가로 예약한다", async () => {
    const { repo, many } = await fixture();
    await seedFinished(repo, many, DAYS.slice(1));
    await created(claim(repo, many, { estCost: 1 }));
    await created(claim(repo, many, { estCost: 1 }));
  });

  it("failed 리포트는 표본이 아니다", async () => {
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

describe("memoryRepo 리포트 상태 (start_episode·save_progress·finish_episode, n = 1)", () => {
  it.each([
    ["queued", true],
    ["failed", true],
    ["partial", true],
    ["running", false],
    ["done", false],
    ["refused", false],
    ["safety", false],
  ])("%s 리포트를 시작하면 %s", async (status, ok) => {
    const { repo, many } = await fixture();
    const id = await created(claim(repo, many));
    if (status === "running") await repo.startReport(id);
    else if (status !== "queued") await finish(repo, id, status);
    expect(await repo.startReport(id)).toBe(ok);
    expect((await repo.getConversation(id))!.report.status).toBe(ok ? "running" : status);
  });

  it("시작하면 error_code·progress를 비우고 content는 둔다", async () => {
    const { repo, many } = await fixture();
    const id = await created(claim(repo, many));
    await repo.startReport(id);
    await repo.saveProgress(id, [{ range: "01-01~01-31", note: "읽는 중" }]);
    await finish(repo, id, "partial", { errorCode: "timeout", content: { headline: "첫 편" } });
    expect(await repo.startReport(id)).toBe(true);
    expect((await repo.getConversation(id))!.report).toEqual({
      status: "running",
      content: { headline: "첫 편" },
      progress: null,
      errorCode: null,
    });
  });

  it("없는 대화는 시작하지 않는다", async () => {
    const { repo } = await fixture();
    expect(await repo.startReport(randomUUID())).toBe(false);
    expect(await repo.startReport("not-a-uuid")).toBe(false);
  });

  it("saveProgress는 running 리포트에만 쓴다", async () => {
    const { repo, many } = await fixture();
    const id = await created(claim(repo, many));
    const notes = [{ range: "01-01~01-31", note: "읽는 중" }];
    await repo.saveProgress(id, notes);
    expect((await repo.getConversation(id))!.report.progress).toBeNull();
    await repo.startReport(id);
    await repo.saveProgress(id, notes);
    expect((await repo.getConversation(id))!.report.progress).toEqual(notes);
    await finish(repo, id, "done");
    await repo.saveProgress(id, [{ range: "02-01~02-28", note: "늦게 온 메모" }]);
    expect((await repo.getConversation(id))!.report.progress).toEqual(notes);
  });

  it("finishReport는 지금 상태와 상관없이 덮어쓴다 (앞의 글이 없을 때)", async () => {
    const { repo, many } = await fixture();
    const id = await created(claim(repo, many));
    await finish(repo, id, "failed", { errorCode: "timeout" });
    expect((await repo.getConversation(id))!.report).toMatchObject({ status: "failed", errorCode: "timeout", content: null });
    await finish(repo, id, "done", { content: { headline: "다시" } });
    expect((await repo.getConversation(id))!.report).toMatchObject({ status: "done", errorCode: null, content: { headline: "다시" } });
  });

  it("모르는 상태로는 끝내지 않는다", async () => {
    const { repo, many } = await fixture();
    const id = await created(claim(repo, many));
    await expect(finish(repo, id, "bogus")).rejects.toThrow();
    expect((await repo.getConversation(id))!.report.status).toBe("queued");
  });
});

describe("memoryRepo 다시 쓰기 판정 (retry_episode)", () => {
  const retry = (repo: AppRepo, id: string, maxRuns = 3) => repo.retryReport({ id, estCost: 1.2, maxRuns });

  it("정지 중이면 paused, 시작할 수 없는 리포트면 not_startable", async () => {
    const { repo, many } = await fixture();
    const done = await created(claim(repo, many));
    const failed = await created(claim(repo, many));
    await finish(repo, done, "done");
    expect(await retry(repo, done)).toBe("not_startable");
    expect(await retry(repo, randomUUID())).toBe("not_startable");
    await repo.setPaused(new Date(Date.now() + 60_000));
    await finish(repo, failed, "failed", { errorCode: "retryable" });
    expect(await retry(repo, failed)).toBe("paused");
    expect((await repo.getConversation(failed))!.report.status).toBe("failed");
  });

  it("리포트의 유료 실행이 상한에 닿으면 retry_limit. 원가 없는 실패는 세지 않는다", async () => {
    const { repo, many } = await fixture();
    const id = await created(claim(repo, many));
    // 응답 전 실패 2번(usage 없음) + 유료 실행 3번
    for (let i = 0; i < 2; i++) await finish(repo, id, "failed", { errorCode: "retryable", usage: null });
    for (let i = 0; i < 3; i++) await finish(repo, id, "partial", { cost: 0.2, content: { headline: "앞의 글" } });
    expect(await retry(repo, id)).toBe("retry_limit");
    expect((await repo.getConversation(id))!.report.status).toBe("partial");
    expect(await retry(repo, id, 4)).toBe("started");
    expect((await repo.getConversation(id))!.report).toMatchObject({ status: "running", content: { headline: "앞의 글" } });
    expect(await retry(repo, id, 4)).toBe("not_startable");
  });

  it("주간 상한: 최근 7일 원가 + 평균 원가 전체(따라 도는 편 없음)가 22.5달러를 넘으면 global_limit", async () => {
    const { repo, many } = await fixture();
    const id = await created(claim(repo, many));
    const other = await created(claim(repo, many));
    await finish(repo, id, "failed", { errorCode: "retryable", usage: null });
    // 다른 대화의 원가로 최근 7일 합을 21.4달러로 만든다
    await finish(repo, other, "done", { cost: 21.4 });
    expect(await retry(repo, id)).toBe("global_limit"); // 21.4 + 1.2 = 22.6
    expect((await repo.getConversation(id))!.report.status).toBe("failed");

    const f = await fixture();
    const a = await created(claim(f.repo, f.many));
    const b = await created(claim(f.repo, f.many));
    await finish(f.repo, a, "failed", { errorCode: "retryable", usage: null });
    await finish(f.repo, b, "done", { cost: 20 });
    expect(await retry(f.repo, a)).toBe("started"); // 20 + 1.2 = 21.2
  });
});

describe("memoryRepo partial 다시 쓰기가 실패해도 앞의 글을 남긴다", () => {
  it("content가 있는 리포트가 failed로 끝나면 partial·content 그대로·error_code만 바뀐다. 원가는 남긴다", async () => {
    const { repo, many } = await fixture();
    const id = await created(claim(repo, many));
    await finish(repo, id, "partial", { content: { headline: "앞의 글" } });
    await repo.startReport(id);
    await finish(repo, id, "failed", { errorCode: "invalid_output", cost: 0.4 });
    expect((await repo.getConversation(id))!.report).toMatchObject({
      status: "partial",
      content: { headline: "앞의 글" },
      errorCode: "invalid_output",
    });
    expect(await repo.retryReport({ id, estCost: 1.2, maxRuns: 1 })).toBe("retry_limit");
  });

  it("content가 없으면 failed 그대로, safety·refused는 덮어쓴다", async () => {
    const { repo, many } = await fixture();
    const a = await created(claim(repo, many));
    await finish(repo, a, "failed", { errorCode: "timeout" });
    expect((await repo.getConversation(a))!.report).toMatchObject({ status: "failed", content: null });
    const b = await created(claim(repo, many));
    await finish(repo, b, "partial", { content: { headline: "앞의 글" } });
    await finish(repo, b, "safety");
    expect((await repo.getConversation(b))!.report).toMatchObject({ status: "safety", content: null });
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
    const share = { tokenHash: "hash-1" };
    expect(await repo.setShare(id, two, share)).toBe(false);
    expect(await repo.getByShareHash("hash-1")).toBeNull();
    expect(await repo.setShare(id, many, share)).toBe(true);
    expect(await repo.getByShareHash("hash-1")).toMatchObject({ id, shareTokenHash: "hash-1" });
    expect(await repo.setShare(id, many, { tokenHash: null })).toBe(true);
    expect(await repo.getByShareHash("hash-1")).toBeNull();
    expect(await repo.getConversation(id)).toMatchObject({ shareTokenHash: null });
  });

  it("expectHash가 지금 해시와 다르면 공유 설정을 쓰지 않는다", async () => {
    const { repo, many } = await fixture();
    const id = await created(claim(repo, many));
    expect(await repo.setShare(id, many, { tokenHash: "h1", expectHash: "x" })).toBe(false);
    expect(await repo.setShare(id, many, { tokenHash: "h1", expectHash: null })).toBe(true);
    expect(await repo.setShare(id, many, { tokenHash: "h2", expectHash: null })).toBe(false);
    expect(await repo.setShare(id, many, { tokenHash: "h1", expectHash: "h1" })).toBe(true);
    await repo.setShare(id, many, { tokenHash: null });
    expect(await repo.setShare(id, many, { tokenHash: "h1", expectHash: "h1" })).toBe(false);
    expect((await repo.getConversation(id))!.shareTokenHash).toBeNull();
  });

  it("만료된 대화는 공유 링크로도 읽히지 않는다", async () => {
    const { repo, many } = await fixture();
    const id = await created(claim(repo, many));
    await repo.setShare(id, many, { tokenHash: "hash-1" });
    at("2026-12-30T10:00:00");
    expect(await repo.getByShareHash("hash-1")).toBeNull();
  });

  it("같은 공유 토큰 해시를 두 대화에 줄 수 없다", async () => {
    const { repo, many } = await fixture();
    const a = await created(claim(repo, many));
    const b = await created(claim(repo, many));
    await repo.setShare(a, many, { tokenHash: "hash-1" });
    await expect(repo.setShare(b, many, { tokenHash: "hash-1" })).rejects.toThrow();
  });

  it("피드백은 정해진 이유로, 있는 대화에만 남긴다", async () => {
    const { repo, many } = await fixture();
    const id = await created(claim(repo, many));
    await expect(repo.addFeedback({ id, paragraphKey: "s1p1", reason: "tone" })).resolves.toBeUndefined();
    await expect(repo.addFeedback({ id, paragraphKey: "s1p1", reason: "boring" })).rejects.toThrow();
    await expect(repo.addFeedback({ id: randomUUID(), paragraphKey: "s1p1", reason: "tone" })).rejects.toThrow();
  });

  it("돌려준 값을 고쳐도 저장된 값은 그대로다", async () => {
    const { repo, many } = await fixture();
    const id = await created(claim(repo, many));
    const row = (await repo.getConversation(id))!;
    row.displayNames.push("X");
    row.report.status = "done";
    expect((await repo.getConversation(id))!.displayNames).toEqual(["나", "P2", "P3"]);
    expect((await repo.getConversation(id))!.report.status).toBe("queued");
  });
});

describe("getRepo", () => {
  const g = globalThis as { analytalkRepoV4?: AppRepo; analytalkDevRepoV4?: AppRepo };
  afterEach(() => {
    delete g.analytalkRepoV4;
    delete g.analytalkDevRepoV4;
  });

  it("E2E 모드는 키가 있어도 고정 초대 코드(월 99건)가 든 memoryRepo를 전역에 하나 둔다", async () => {
    vi.stubEnv("ANALYTALK_E2E", "1");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_test");
    const repo = getRepo();
    expect(getRepo()).toBe(repo);
    expect(g.analytalkRepoV4).toBe(repo);
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

  it("Supabase getPausedUntil은 settings(id 1)의 paused_until을 읽는다. null이면 null, 오류면 코드만 담아 던진다", async () => {
    vi.stubEnv("ANALYTALK_E2E", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_test");
    const replies = [
      Response.json([{ paused_until: "2026-12-01T00:00:00+00:00" }]),
      Response.json([{ paused_until: null }]),
      Response.json({ code: "42501", message: "permission denied", details: "secret detail" }, { status: 403 }),
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => replies.shift()!);
    vi.stubGlobal("fetch", fetch);
    const repo = getRepo();
    expect(await repo.getPausedUntil()).toEqual(new Date("2026-12-01T00:00:00Z"));
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.pathname).toBe("/rest/v1/settings");
    expect(Object.fromEntries(url.searchParams)).toEqual({ select: "paused_until", id: "eq.1" });
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get("accept-profile")).toBe("analytalk");
    expect(await repo.getPausedUntil()).toBeNull();
    await expect(repo.getPausedUntil()).rejects.toThrow("[repo] getPausedUntil 실패 (42501)");
  });
});

describe("supabaseRepo (PostgREST 요청·응답 흉내, Review Focus 4)", () => {
  const ID = "0b6c3f1e-2a4d-4c5b-9e8f-7a6b5c4d3e2f";
  const INVITE = "1c7d4f2e-3b5e-4d6c-8f9a-8b7c6d5e4f3a";

  /** replies를 차례로 돌려주는 fetch로 Supabase 저장소를 만든다 */
  function supabase(...replies: Response[]) {
    vi.stubEnv("ANALYTALK_E2E", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_test");
    const fetch = vi.fn<typeof globalThis.fetch>(async () => replies.shift() ?? Response.json(null));
    vi.stubGlobal("fetch", fetch);
    const calls = () =>
      fetch.mock.calls.map(([url, init]) => ({
        url: new URL(String(url)),
        method: init?.method,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      }));
    return { repo: getRepo(), calls };
  }

  /** v1 앱이 남긴 대화 행(편 4행 임베드, share_scope·share_hidden은 select하지 않는다) */
  const dbRow = (episodes: object[]) => ({
    id: ID,
    invite_id: INVITE,
    concept: "group",
    tone: "fact",
    kind: "group",
    period_start: "2026-01-01",
    period_end: "2026-06-30",
    cutoff_at: "2026-06-30T03:00:00+00:00",
    msg_total: 1000,
    msg_sent: 800,
    display_names: ["P1", "P2"],
    stats: { messages: 1000 },
    payload_sha256: "abc",
    share_token_hash: null,
    expires_at: "2026-12-30T01:00:00+00:00",
    episodes,
  });
  const ep = (n: number, status: string) => ({ n, status, content: { headline: `${n}편` }, progress: null, error_code: n === 1 ? null : "dispatch" });

  it("getConversation: 임베드에 편 4행이 와도 report는 n = 1 행. select에 tone이 있고 share_scope·share_hidden·finished_at은 없다", async () => {
    const { repo, calls } = supabase(Response.json([dbRow([ep(3, "failed"), ep(1, "done"), ep(2, "queued"), ep(4, "failed")])]));
    const row = await repo.getConversation(ID);
    expect(row).toEqual({
      id: ID,
      inviteId: INVITE,
      concept: "group",
      tone: "fact",
      kind: "group",
      periodStart: "2026-01-01",
      periodEnd: "2026-06-30",
      cutoffAt: "2026-06-30T03:00:00.000Z",
      msgTotal: 1000,
      msgSent: 800,
      displayNames: ["P1", "P2"],
      stats: { messages: 1000 },
      payloadSha256: "abc",
      shareTokenHash: null,
      expiresAt: "2026-12-30T01:00:00.000Z",
      report: { status: "done", content: { headline: "1편" }, progress: null, errorCode: null },
    });
    const select = calls()[0].url.searchParams.get("select")!;
    expect(select).toMatch(/\btone\b/);
    expect(select).not.toMatch(/share_scope|share_hidden|finished_at/);
    expect(select).toContain("episodes(n,status,content,progress,error_code)");
  });

  it("n = 1 행이 없으면 getConversation·getByShareHash는 null", async () => {
    const { repo } = supabase(Response.json([dbRow([ep(2, "queued")])]), Response.json([dbRow([])]));
    expect(await repo.getConversation(ID)).toBeNull();
    expect(await repo.getByShareHash("hash-1")).toBeNull();
  });

  it("RPC 본문: find_duplicate에 p_tone, 리포트 함수는 p_n = 1", async () => {
    const { repo, calls } = supabase(
      Response.json(null),
      Response.json(true),
      Response.json("started"),
      Response.json(null),
      Response.json(null),
    );
    await repo.findDuplicate({ inviteId: INVITE, payloadSha256: "abc", concept: "group", tone: "warm", promptVersion: "v2" });
    await repo.startReport(ID);
    await repo.retryReport({ id: ID, estCost: 1.2, maxRuns: 3 });
    await repo.saveProgress(ID, [{ range: "01-01~01-31", note: "읽는 중" }]);
    await repo.finishReport({
      id: ID,
      status: "done",
      content: { headline: "리포트" },
      model: "claude-sonnet-5-5",
      stopReason: "end_turn",
      errorCode: null,
      usage: USAGE,
      cost: 0.5,
    });
    const rpc = calls().map((c) => [c.url.pathname.replace("/rest/v1/rpc/", ""), c.body]);
    expect(rpc).toEqual([
      ["find_duplicate", { p_invite_id: INVITE, p_payload_sha256: "abc", p_concept: "group", p_tone: "warm", p_prompt_version: "v2" }],
      ["start_episode", { p_id: ID, p_n: 1 }],
      ["retry_episode", { p_id: ID, p_n: 1, p_est_cost: 1.2, p_max_runs: 3 }],
      ["save_progress", { p_id: ID, p_n: 1, p_notes: [{ range: "01-01~01-31", note: "읽는 중" }] }],
      [
        "finish_episode",
        {
          p_id: ID,
          p_n: 1,
          p_status: "done",
          p_content: { headline: "리포트" },
          p_model: "claude-sonnet-5-5",
          p_stop_reason: "end_turn",
          p_error_code: null,
          p_usage: USAGE,
          p_cost: 0.5,
        },
      ],
    ]);
  });

  it("공유 발급은 scope 'all'·hidden []도 써 두고(v1 코드로 되돌려도 링크가 산다), 폐기는 해시만 비운다. 피드백은 n = 1", async () => {
    const { repo, calls } = supabase(Response.json([{ id: ID }]), Response.json([{ id: ID }]), new Response(null, { status: 201 }));
    expect(await repo.setShare(ID, INVITE, { tokenHash: "hash-1", expectHash: null })).toBe(true);
    expect(await repo.setShare(ID, INVITE, { tokenHash: null })).toBe(true);
    await repo.addFeedback({ id: ID, paragraphKey: "s1.p1", reason: "tone" });
    const [issue, revoke, feedback] = calls();
    expect([issue.method, issue.body]).toEqual(["PATCH", { share_token_hash: "hash-1", share_scope: "all", share_hidden: [] }]);
    expect(issue.url.searchParams.get("share_token_hash")).toBe("is.null");
    expect([revoke.method, revoke.body]).toEqual(["PATCH", { share_token_hash: null }]);
    expect([feedback.url.pathname, feedback.body]).toEqual([
      "/rest/v1/feedback",
      { conversation_id: ID, n: 1, paragraph_key: "s1.p1", reason: "tone" },
    ]);
  });
});
