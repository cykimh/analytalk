// 스크립트(measure·eval)의 원장 기록과 지출 확인. 유료 실행은 이 확인을 거친 뒤에만 API를 부른다.
// usage_events의 source='script' 행은 앱의 주간 차단 합계에 들어간다(record_script_usage).
import type { Usage } from "../lib/llm/cost";
import type { Io } from "./invite";

export interface LedgerItem {
  model: string;
  usage: Usage;
  costUsd: number;
}

export interface Rpc {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }>;
}

interface Result<T> {
  data: T | null;
  error: { message: string } | null;
}

/** weeklyHeadroom이 읽는 부분만 좁힌 Supabase 클라이언트 모양 */
export interface Db {
  from(table: "settings"): {
    select(cols: string): { eq(col: string, v: number): { single(): PromiseLike<Result<{ weekly_cap_usd: number | string | null }>> } };
  };
  from(table: "usage_events"): {
    select(cols: string): { gte(col: string, v: string): PromiseLike<Result<{ cost_usd_est: number | string | null }[]>> };
  };
}

const round = (x: number, d = 6) => Math.round(x * 10 ** d) / 10 ** d;

/** 모델별로 사용량·원가를 합쳐 record_script_usage로 원장에 남긴다 */
export async function recordUsage(db: Rpc, items: LedgerItem[]): Promise<void> {
  const byModel = new Map<string, { usage: Usage; cost: number }>();
  for (const it of items) {
    const cur = byModel.get(it.model) ?? {
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      cost: 0,
    };
    cur.usage.input_tokens += it.usage.input_tokens;
    cur.usage.output_tokens += it.usage.output_tokens;
    cur.usage.cache_creation_input_tokens += it.usage.cache_creation_input_tokens;
    cur.usage.cache_read_input_tokens += it.usage.cache_read_input_tokens;
    cur.cost += it.costUsd;
    byModel.set(it.model, cur);
  }
  for (const [model, v] of byModel) {
    const { error } = await db.rpc("record_script_usage", { p_model: model, p_usage: v.usage, p_cost: round(v.cost) });
    if (error) throw new Error("원장 기록에 실패했다");
  }
}

/** settings.weekly_cap_usd에서 최근 7일 usage_events 원가 합을 뺀 남은 주간 한도. 설정값이 null이면 한도 0(앱의 차단과 같다) */
export async function weeklyHeadroom(
  db: Db,
  now: () => number = Date.now,
): Promise<{ capUsd: number; spentUsd: number; leftUsd: number }> {
  const cap = await db.from("settings").select("weekly_cap_usd").eq("id", 1).single();
  if (cap.error || !cap.data) throw new Error("주간 한도를 읽지 못했다");
  const since = new Date(now() - 7 * 86_400_000).toISOString();
  const spent = await db.from("usage_events").select("cost_usd_est").gte("at", since);
  if (spent.error || !spent.data) throw new Error("최근 7일 원가를 읽지 못했다");
  const capUsd = Number(cap.data.weekly_cap_usd ?? 0);
  const spentUsd = round(spent.data.reduce((s, r) => s + Number(r.cost_usd_est ?? 0), 0));
  return { capUsd, spentUsd, leftUsd: round(capUsd - spentUsd) };
}

/** 추정 원가·남은 주간 한도·DB 호스트를 찍고 y/N을 받는다. 남은 한도가 추정 원가보다 작으면 yes여도 false다 */
export async function confirmSpend(
  io: Io,
  a: { estUsd: number; headroom: { leftUsd: number }; host: string; yes: boolean },
): Promise<boolean> {
  io.log(`추정 원가 $${a.estUsd}, 남은 주간 한도 $${a.headroom.leftUsd}, DB ${a.host}`);
  if (a.headroom.leftUsd < a.estUsd) {
    io.log("남은 주간 한도가 추정 원가보다 작아 실행하지 않는다");
    return false;
  }
  if (a.yes) return true;
  return io.confirm("유료 실행: y/N ");
}
