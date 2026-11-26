import { describe, expect, it, vi } from "vitest";
import { confirmSpend, type Db, recordUsage, weeklyHeadroom } from "./ledger";

describe("recordUsage", () => {
  it("모델별로 사용량·원가를 합쳐 record_script_usage를 한 번씩 부른다", async () => {
    const rpc = vi.fn(async () => ({ error: null }));
    const u = (o: number) => ({ input_tokens: 10, output_tokens: o, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 });
    await recordUsage({ rpc }, [
      { model: "claude-opus-5-5", usage: u(100), costUsd: 0.5 },
      { model: "claude-opus-5-5", usage: u(200), costUsd: 0.25 },
    ]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("record_script_usage", {
      p_model: "claude-opus-5-5",
      p_usage: { input_tokens: 20, output_tokens: 300, cache_creation_input_tokens: 2, cache_read_input_tokens: 4 },
      p_cost: 0.75,
    });
  });
  it("rpc 오류는 던진다", async () => {
    const zero = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    await expect(recordUsage({ rpc: async () => ({ error: { message: "x" } }) }, [{ model: "m", usage: zero, costUsd: 1 }])).rejects.toThrow(/원장/);
  });
});

describe("weeklyHeadroom", () => {
  it("주간 한도에서 최근 7일 원가 합을 뺀다", async () => {
    const since: string[] = [];
    const db = {
      from(table: string) {
        if (table === "settings") return { select: () => ({ eq: () => ({ single: async () => ({ data: { weekly_cap_usd: 22.5 }, error: null }) }) }) };
        return {
          select: () => ({
            gte: async (_col: string, v: string) => {
              since.push(v);
              return { data: [{ cost_usd_est: 6 }, { cost_usd_est: "8" }, { cost_usd_est: null }], error: null };
            },
          }),
        };
      },
    } as unknown as Db;
    const now = Date.UTC(2026, 10, 26);
    expect(await weeklyHeadroom(db, () => now)).toEqual({ capUsd: 22.5, spentUsd: 14, leftUsd: 8.5 });
    expect(since).toEqual([new Date(now - 7 * 86_400_000).toISOString()]);
  });
});

describe("confirmSpend", () => {
  const io = (answer: boolean) => {
    const lines: string[] = [];
    return { lines, io: { log: (l: string) => lines.push(l), confirm: vi.fn(async () => answer) } };
  };
  it("추정 원가·남은 한도·호스트를 찍고 답이 n이면 false", async () => {
    const t = io(false);
    expect(await confirmSpend(t.io, { estUsd: 1.2, headroom: { leftUsd: 8.5 }, host: "db.example.co", yes: false })).toBe(false);
    expect(t.lines.join("\n")).toMatch(/1\.2/);
    expect(t.lines.join("\n")).toMatch(/8\.5/);
    expect(t.lines.join("\n")).toMatch(/db\.example\.co/);
    expect(t.io.confirm).toHaveBeenCalledTimes(1);
  });
  it("답이 y면 true, --yes면 묻지 않고 true", async () => {
    expect(await confirmSpend(io(true).io, { estUsd: 1, headroom: { leftUsd: 5 }, host: "h", yes: false })).toBe(true);
    const t = io(false);
    expect(await confirmSpend(t.io, { estUsd: 1, headroom: { leftUsd: 5 }, host: "h", yes: true })).toBe(true);
    expect(t.io.confirm).not.toHaveBeenCalled();
  });
  it("남은 한도가 추정 원가보다 작으면 yes여도 false, 묻지 않는다", async () => {
    const t = io(true);
    expect(await confirmSpend(t.io, { estUsd: 2, headroom: { leftUsd: 1 }, host: "h", yes: true })).toBe(false);
    expect(t.io.confirm).not.toHaveBeenCalled();
    expect(t.lines.join("\n")).toMatch(/한도/);
  });
});
