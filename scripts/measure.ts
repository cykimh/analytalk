// 실측(비용이 드는 실행, 사용자가 직접 돌린다). 리포트 한 번을 기준으로 잰다(v2.5: 앱과 같이 호출 3~4개로 나눠 쓴 한 편).
//
//   pnpm measure <파일> [--concept group|couple] [--tone fact|warm|show|docu|detective|record] [--model id] [--budget n] [--runs n]
//                       [--count-only | --check-limits] [--dry-run] [--prod] [--yes]
//
// 파싱 → 표시 이름(카톡 이름) → buildPayloadForBudget → (실행 모드에 따라)
//   --dry-run      추정 토큰과 줄 모양 비교(v2.7: 같은 예산에서 한 줄에 하나씩 vs 묶고 접은 모양의 보낸 원본 메시지 수)만 찍고 멈춘다
//                  (API·DB 호출, 파일 쓰기 없음, 키 불필요)
//   --count-only   countTokens만(무료): 글자당 토큰, 고정 몫(system·통계·지시)
//   --check-limits 첫 호출(buildRequests[0])과 같은 모양의 아주 작은 요청을 보내 rate limit 헤더를 찍는다(유료, 소액)
//   (기본)         countTokens + 리포트 --runs회 실행(유료). 실행마다 원장(record_script_usage)에 바로 기록
// 유료 모드는 confirmSpend(추정 원가·남은 주간 한도·DB 호스트, y/N)를 통과해야 API를 부른다.
// --prod는 .env.production.local의 DB로 원장·한도를 본다(API 키는 .env.local의 것을 우선 쓴다).
// 출력은 숫자뿐이다: 대화 내용·이름·파일 이름·모델 원문은 찍지도 저장하지도 않는다.
// 결과 JSON은 ~/Developer/analytalk-samples/measure-<ts>.json (저장소 밖)에 쓴다.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { MessageCountTokensParams } from "@anthropic-ai/sdk/resources/messages";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { DEFAULT_EST_COST_USD, EPISODE_DEADLINE_MS, TOKENS_PER_CHAR } from "../lib/config";
import { DEFAULT_TONE, PICKABLE_TONES, type PickableTone } from "../lib/llm/concepts";
import { estimateCostUsd } from "../lib/llm/cost";
import { buildRequests, countRequest } from "../lib/llm/prompt";
import { type ModelSettings, modelSettings } from "../lib/llm/settings";
import { mergeReportCalls, runReportCalls } from "../lib/llm/split";
import { applyDisplayNames, defaultNames, isBotOrUnknown, type NameMap } from "../lib/payload/names";
import { dropSafetyFlagged } from "../lib/payload/safety";
import { buildPayloadForBudget, type Payload, payloadTokens } from "../lib/payload/build";
import { type ChatMessage, parseExport } from "../lib/parse/parse";
import { readUploads } from "../lib/parse/uploads";
import { privilegedDb } from "../lib/server/privileged";
import { isYes } from "./invite";
import { confirmSpend, type Db, type LedgerItem, type Rpc, recordUsage, weeklyHeadroom } from "./ledger";

// ── 인자 ──

export interface Args {
  file: string;
  concept: "group" | "couple";
  tone: PickableTone;
  /** null이면 앱 기본(ANTHROPIC_MODEL 또는 DEFAULT_MODEL) */
  model: string | null;
  /** null이면 모델의 입력 예산(INPUT_TOKEN_BUDGET env가 있으면 그 값) */
  budget: number | null;
  runs: number;
  mode: "count" | "limits" | "run";
  dryRun: boolean;
  prod: boolean;
  yes: boolean;
}

export function parseArgs(argv: string[]): Args {
  const files: string[] = [];
  const args: Omit<Args, "file"> = {
    concept: "group",
    tone: DEFAULT_TONE,
    model: null,
    budget: null,
    runs: 1,
    mode: "run",
    dryRun: false,
    prod: false,
    yes: false,
  };
  let countOnly = false;
  let checkLimits = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--prod") args.prod = true;
    else if (a === "--yes") args.yes = true;
    else if (a === "--count-only") countOnly = true;
    else if (a === "--check-limits") checkLimits = true;
    else if (a === "--concept") {
      const v = argv[++i];
      if (v !== "group" && v !== "couple") throw new Error("--concept은 group 또는 couple이다");
      args.concept = v;
    } else if (a === "--tone") {
      const v = argv[++i];
      if (!(PICKABLE_TONES as readonly string[]).includes(v)) throw new Error(`--tone은 ${PICKABLE_TONES.join("|")}이다`);
      args.tone = v as PickableTone;
    } else if (a === "--model") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error("--model에 모델 id를 지정한다");
      args.model = v;
    } else if (a === "--budget") {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 1) throw new Error("--budget은 1 이상의 정수다");
      args.budget = v;
    } else if (a === "--runs") {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 1) throw new Error("--runs는 1 이상의 정수다");
      args.runs = v;
    } else if (a.startsWith("--")) throw new Error(`알 수 없는 옵션이다: ${a}`);
    else files.push(a);
  }
  if (countOnly && checkLimits) throw new Error("--count-only와 --check-limits는 동시에 쓰지 않는다");
  if (files.length === 0) throw new Error("샘플 파일을 지정한다");
  if (files.length > 1) throw new Error("샘플 파일은 하나만 지정한다");
  return { file: files[0], ...args, mode: countOnly ? "count" : checkLimits ? "limits" : "run" };
}

// ── 이름·페이로드 ──

/** 발신자마다 기본 표시 이름(성을 뺀 카톡 이름, 봇·알 수 없음 제외)을 준다. 앱의 이름 단계 기본값과 같다 */
export function displayNames(p: { participants: string[] }): NameMap {
  return defaultNames(p.participants.filter((n) => n !== "" && !isBotOrUnknown(n)));
}

/** 앱과 같이 이름을 붙이고(뺀 봇 포함) 위험 신호 메시지를 뺀 메시지 */
export function namedMessages(p: { participants: string[]; messages: ChatMessage[] }, label?: string): ChatMessage[] {
  const named = applyDisplayNames(p.messages, { map: displayNames(p) });
  if (!named.ok) throw new Error(`이름 부여 실패${label ? `(${label})` : ""}: ${named.reason}`);
  return dropSafetyFlagged(named.messages).messages;
}

/**
 * 입력 예산(s.inputBudget)에서 통계 요약·프롬프트 몫(PROMPT_RESERVE_TOKENS)을 빼고 맞춘 페이로드.
 * compact가 false면 v2.6까지의 줄 모양(한 줄에 하나씩)으로 만든다(compareLineStyles용)
 */
export function measurePayload(messages: ChatMessage[], concept: Args["concept"], tone: PickableTone, s: ModelSettings, compact = true): Payload {
  return buildPayloadForBudget({
    messages,
    concept,
    tone,
    kind: concept === "couple" ? "pair" : "group",
    inputBudget: s.inputBudget,
    tokensPerChar: TOKENS_PER_CHAR,
    compact,
  });
}

/**
 * v2.7 효과: 같은 입력 예산에서 transcript에 들어가는 원본 메시지 수(msgSent)를 한 줄에 하나씩(plain)과 묶고 접은 모양(compact)으로 견준다.
 * gainPct = (compact − plain) / plain × 100. API를 부르지 않는다(--dry-run에서도 찍는다)
 */
export function compareLineStyles(messages: ChatMessage[], concept: Args["concept"], tone: PickableTone, s: ModelSettings) {
  const plain = measurePayload(messages, concept, tone, s, false).msgSent;
  const compact = measurePayload(messages, concept, tone, s).msgSent;
  return { plain, compact, gainPct: round(((compact - plain) / plain) * 100, 1) };
}

/** 인자의 --model·--budget을 앱 설정(env)에 덮어쓴다. --model만 주면 입력 예산도 그 모델 기준(INPUT_TOKEN_BUDGET env는 무시) */
export function settingsFor(args: Pick<Args, "model" | "budget">, env: Record<string, string | undefined> = process.env): ModelSettings {
  const base = args.model ? { ...env, ANTHROPIC_MODEL: args.model, INPUT_TOKEN_BUDGET: undefined } : env;
  const s = modelSettings(base);
  return args.budget ? { ...s, inputBudget: args.budget } : s;
}

// ── 집계 ──

const round = (x: number, d = 6) => Math.round(x * 10 ** d) / 10 ** d;

/** nearest-rank 백분위수. 빈 배열은 0 */
export function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

export interface ReportMeasure {
  /** 요청부터 ①의 message_start까지. 응답 시작 전에 끝났으면 null */
  ttftMs: number | null;
  /** 요청부터 마지막 호출이 끝날 때까지 */
  totalMs: number;
  /** 호출 수(v2.5: 3~4)와 호출마다 runReport 결과(시작하지 않았으면 not_started) */
  calls: number;
  callKinds: string[];
  /** 아래 토큰은 호출 합이다. inputTokens는 캐시 밖 입력만 */
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  /** 출력 중 생각 몫. 응답이 알려 줄 때만 */
  thinkingTokens: number | null;
  costUsd: number;
  requestedModel: string;
  servedModel: string;
  /** 응답 모델이 요청 모델과 다르다(서버 측 fallback) */
  fallback: boolean;
  /** 거절 분류. 거절이 아니면 null */
  stopCategory: string | null;
  /** 합친 리포트의 저장 상태(mergeReportCalls) */
  status: "done" | "partial" | "safety" | "failed" | "refused";
  /** ok가 아닌 첫 호출의 runReport 결과(모두 ok면 ok) */
  kind: string;
}

export interface Summary {
  runs: number;
  costUsdAvg: number;
  costUsdTotal: number;
  p95TotalMs: number;
  p95TtftMs: number;
  fallbacks: number;
  /** kind가 ok가 아닌 회차 */
  notOk: number;
}

export function summarize(reports: ReportMeasure[]): Summary {
  const costUsdTotal = round(reports.reduce((s, r) => s + r.costUsd, 0));
  return {
    runs: reports.length,
    costUsdAvg: reports.length === 0 ? 0 : round(costUsdTotal / reports.length),
    costUsdTotal,
    p95TotalMs: percentile(reports.map((r) => r.totalMs), 0.95),
    p95TtftMs: percentile(reports.flatMap((r) => (r.ttftMs === null ? [] : [r.ttftMs])), 0.95),
    fallbacks: reports.filter((r) => r.fallback).length,
    notOk: reports.filter((r) => r.kind !== "ok").length,
  };
}

/** 통과 기준: p95 240초 이하, 평균 원가가 DEFAULT_EST_COST_USD ±30%, fallback 0, kind ok 아닌 회차 0. 마감은 EPISODE_DEADLINE_MS */
export function judge(s: Summary) {
  const p95 = s.p95TotalMs <= 240_000;
  const cost = s.runs > 0 && Math.abs(s.costUsdAvg - DEFAULT_EST_COST_USD) <= DEFAULT_EST_COST_USD * 0.3;
  const fallback = s.fallbacks === 0;
  const ok = s.notOk === 0;
  return { p95, cost, fallback, ok, pass: s.runs > 0 && p95 && cost && fallback && ok };
}

// ── 토큰 ──

export interface TokenMeasure {
  model: string;
  fullTokens: number;
  /** 대화 본문(anchors·transcript)을 비운 같은 요청의 토큰: system + 통계 + 범례 + 지시 + 스키마 */
  overheadTokens: number;
  dataChars: number;
  tokensPerChar: number;
  /** 고정 몫 실측 − 코드가 어림한 통계·범례 몫. config의 PROMPT_RESERVE_TOKENS와 비교한다 */
  reserveTokens: number;
  /** TOKENS_PER_CHAR로 어림한 본문 토큰 / 실측 본문 토큰. 1보다 크면 어림이 넉넉하다 */
  estimateRatio: number;
}

type CountClient = Pick<Anthropic, "messages">;

/** 서버 countInputTokens와 같은 5필드 요청(지시가 가장 긴 호출)의 입력 토큰(betas·fallbacks·max_tokens 제외) */
async function countInput(client: CountClient, p: Payload, s: ModelSettings): Promise<number> {
  const { model, system, messages, thinking, output_config } = countRequest(p, s);
  const counted = await client.messages.countTokens({
    model,
    system,
    messages: messages as MessageCountTokensParams["messages"],
    thinking: thinking as MessageCountTokensParams["thinking"],
    output_config,
  });
  return counted.input_tokens;
}

/** countTokens(무료)를 두 번: 전체 요청과 대화 본문을 비운 요청. 둘의 차이가 본문 토큰이다 */
export async function measureTokens(client: CountClient, payload: Payload, s: ModelSettings): Promise<TokenMeasure> {
  const fullTokens = await countInput(client, payload, s);
  const overheadTokens = await countInput(client, { ...payload, anchors: "", transcript: "" }, s);
  const dataChars = payload.anchors.length + payload.transcript.length;
  if (dataChars === 0) throw new Error("대화 본문이 비어 있어 잴 수 없다");
  const dataTokens = fullTokens - overheadTokens;
  const tokensPerChar = dataTokens / dataChars;
  const est = payloadTokens(payload, tokensPerChar);
  const estimated = payloadTokens(payload, TOKENS_PER_CHAR).text;
  return {
    model: s.model,
    fullTokens,
    overheadTokens,
    dataChars,
    tokensPerChar: round(tokensPerChar, 4),
    reserveTokens: Math.round(overheadTokens - (est.total - est.text)),
    estimateRatio: dataTokens > 0 ? round(estimated / dataTokens, 4) : 0,
  };
}

// ── 리포트 실행 ──

/** 리포트 한 번(호출 3~4개). 응답 시간·토큰·원가·요청/응답 모델을 잰다. 응답 전 오류를 다시 하지 않는다(있는 그대로 잰다) */
export async function measureReport(
  client: Anthropic,
  payload: Payload,
  s: ModelSettings,
  deps: { now?: () => number } = {},
): Promise<ReportMeasure & { ledger: LedgerItem[] }> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  let ttftMs: number | null = null;
  const results = await runReportCalls(client, buildRequests(payload, s), {
    deadlineAt: Date.now() + EPISODE_DEADLINE_MS,
    now,
    retryWindowMs: -1,
    onNotes: () => {},
    onStreamStart: (part) => {
      if (part === "intro" && ttftMs === null) ttftMs = now() - t0;
    },
  });
  const totalMs = now() - t0;
  const merged = mergeReportCalls(payload, results);
  const ran = results.flatMap(({ r }) => (r ? [r] : []));
  const sum = (pick: (u: NonNullable<(typeof ran)[number]["usage"]>) => number) => ran.reduce((n, r) => n + (r.usage ? pick(r.usage) : 0), 0);
  const thinking = ran.flatMap((r) => (r.thinkingTokens === undefined ? [] : [r.thinkingTokens]));
  const ledger = ran.flatMap((r) => (r.usage ? [{ model: r.model, usage: r.usage, costUsd: round(estimateCostUsd(r.usage, r.model)) }] : []));
  return {
    ttftMs,
    totalMs,
    calls: results.length,
    callKinds: results.map(({ r }) => r?.kind ?? "not_started"),
    inputTokens: sum((u) => u.input_tokens),
    cacheWriteTokens: sum((u) => u.cache_creation_input_tokens),
    cacheReadTokens: sum((u) => u.cache_read_input_tokens),
    outputTokens: sum((u) => u.output_tokens),
    thinkingTokens: thinking.length > 0 ? thinking.reduce((a, b) => a + b, 0) : null,
    costUsd: round(merged.cost),
    requestedModel: s.model,
    servedModel: merged.model ?? s.model,
    fallback: ran.some((r) => r.startedStream && r.model !== s.model),
    stopCategory: ran.find((r) => r.stopCategory !== null)?.stopCategory ?? null,
    status: merged.status,
    kind: merged.kind,
    ledger,
  };
}

// ── rate limit ──

const headerInt = (h: Headers, name: string): number | null => {
  const v = Number(h.get(name));
  return h.get(name) !== null && Number.isFinite(v) ? v : null;
};

/** Anthropic rate limit 응답 헤더(anthropic-ratelimit-*-limit)에서 분당 한도를 읽는다 */
export function rateLimitsFrom(headers: Headers) {
  return {
    inputTokensPerMin: headerInt(headers, "anthropic-ratelimit-input-tokens-limit"),
    outputTokensPerMin: headerInt(headers, "anthropic-ratelimit-output-tokens-limit"),
    requestsPerMin: headerInt(headers, "anthropic-ratelimit-requests-limit"),
  };
}

/** 분당 입력 한도(ITPM)가 예산 × 1.05보다 작으면 floor(ITPM × 0.9)를 권한다. 아니면 null */
export function recommendBudget(itpm: number | null, budget: number): number | null {
  return itpm !== null && itpm < budget * 1.05 ? Math.floor(itpm * 0.9) : null;
}

/**
 * 첫 호출(buildRequests[0])과 같은 모양(user 데이터 + 지시 자리, betas, fallbacks)의 아주 작은 요청(max_tokens 16)을 보내 한도 헤더를 읽는다.
 * 400이면 그 요청 모양이 이 모델·fallback 조합에서 막힌 것이라 상태만 돌려준다(결정 20: 지시 자리를 user로 바꾸는 근거)
 */
export async function checkLimits(
  client: Pick<Anthropic, "beta">,
  payload: Payload,
  s: ModelSettings,
): Promise<{ status: number; limits: ReturnType<typeof rateLimitsFrom>; ledger: LedgerItem[] }> {
  const tiny: Payload = { ...payload, anchors: "", transcript: "m0|00:00|A|." };
  const req = { ...buildRequests(tiny, s)[0].req, max_tokens: 16, stream: false } as unknown as MessageCreateParamsNonStreaming;
  try {
    const { data, response } = await client.beta.messages.create(req).withResponse();
    const u = data.usage;
    const usage = {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    };
    return { status: response.status, limits: rateLimitsFrom(response.headers), ledger: [{ model: data.model, usage, costUsd: round(estimateCostUsd(usage, data.model)) }] };
  } catch (e) {
    if (e instanceof Anthropic.APIError) {
      return { status: e.status ?? 0, limits: rateLimitsFrom(e.headers ?? new Headers()), ledger: [] };
    }
    throw e;
  }
}

// ── 진입점 ──

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const s = settingsFor(args);
  const parsed = parseExport(await readUploads([new File([readFileSync(args.file)], basename(args.file))]));
  if (parsed.formatId === null) throw new Error("형식을 알아보지 못했다");
  const messages = namedMessages(parsed);
  const payload = measurePayload(messages, args.concept, args.tone, s);
  const est = payloadTokens(payload, TOKENS_PER_CHAR);
  console.log(`모델 ${s.model}, 예산 ${s.inputBudget}, 말투 ${args.tone}`);
  const { msgTotal, msgSent } = payload;
  console.log(`메시지 ${msgTotal}건, 보낸 ${msgSent}건, 추정 토큰 ${est.total}(본문 ${est.text})`);
  const styles = compareLineStyles(messages, args.concept, args.tone, s);
  console.log(`줄 모양(v2.7): 한 줄에 하나씩이면 ${styles.plain}건, 묶고 접으면 ${styles.compact}건(${styles.gainPct >= 0 ? "+" : ""}${styles.gainPct}%)`);
  if (args.dryRun) return;

  const env = args.prod ? parseEnv(readFileSync(".env.production.local", "utf8")) : process.env;
  const key = process.env.ANTHROPIC_API_KEY ?? env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY가 없다(.env.local)");
  const client = new Anthropic({ apiKey: key, maxRetries: 0 });

  const tokens = await measureTokens(client, payload, s);
  console.log(
    `countTokens 전체 ${tokens.fullTokens}, 본문 뺀 ${tokens.overheadTokens}, 본문 글자 ${tokens.dataChars}, 글자당 토큰 ${tokens.tokensPerChar}, 고정 몫 ${tokens.reserveTokens}, 어림/실측 ${tokens.estimateRatio}`,
  );

  const out: Record<string, unknown> = { args: { concept: args.concept, tone: args.tone, model: s.model, budget: s.inputBudget, runs: args.runs, mode: args.mode }, tokens };
  if (args.mode !== "count") {
    const dbClient = privilegedDb(env);
    if (!dbClient) throw new Error("Supabase 연결 정보가 없어 원장·한도를 확인할 수 없다");
    const db = dbClient as unknown as Db & Rpc;
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const io = { log: (line: string) => console.log(line), confirm: async (q: string) => isYes(await rl.question(q)) };
      const estUsd = round(args.mode === "limits" ? 0.05 : DEFAULT_EST_COST_USD * args.runs, 4);
      const url = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
      if (!(await confirmSpend(io, { estUsd, headroom: await weeklyHeadroom(db), host: url ? new URL(url).host : "?", yes: args.yes }))) {
        console.log("취소했다");
        process.exitCode = 1;
        return;
      }
    } finally {
      rl.close();
    }

    if (args.mode === "limits") {
      const r = await checkLimits(client, payload, s);
      if (r.ledger.length > 0) await recordUsage(db, r.ledger);
      if (r.status === 400) console.log("요청 모양이 400으로 막혔다(지시 자리를 user로 바꾸는 것을 검토: 결정 20)");
      console.log(`상태 ${r.status}, 분당 입력 ${r.limits.inputTokensPerMin ?? "-"}, 출력 ${r.limits.outputTokensPerMin ?? "-"}, 요청 ${r.limits.requestsPerMin ?? "-"}`);
      const rec = recommendBudget(r.limits.inputTokensPerMin, s.inputBudget);
      if (rec !== null) console.log(`분당 입력 한도가 예산보다 작다 => 권장 예산 ${rec}`);
      out.limits = r;
    } else {
      const reports: ReportMeasure[] = [];
      for (let i = 0; i < args.runs; i++) {
        const { ledger, ...r } = await measureReport(client, payload, s);
        reports.push(r);
        // 실행마다 바로 원장에 남긴다(중간에 죽어도 쓴 돈이 잡힌다)
        if (ledger.length > 0) await recordUsage(db, ledger);
        console.log(
          `run ${i + 1} 호출 ${r.calls}(${r.callKinds.join(",")}) ttft ${r.ttftMs ?? "-"}ms 총 ${r.totalMs}ms 입력 ${r.inputTokens} 캐시 쓰기 ${r.cacheWriteTokens} 읽기 ${r.cacheReadTokens} 출력 ${r.outputTokens} 생각 ${r.thinkingTokens ?? "-"} 원가 $${r.costUsd} 모델 ${r.servedModel}${r.fallback ? "(fallback)" : ""} ${r.kind}/${r.status}${r.stopCategory ? ` 거절 ${r.stopCategory}` : ""}`,
        );
      }
      const summary = summarize(reports);
      const verdict = judge(summary);
      console.log(`평균 원가 $${summary.costUsdAvg}(추정 $${DEFAULT_EST_COST_USD}), p95 총 ${summary.p95TotalMs}ms, fallback ${summary.fallbacks}, ok 아닌 회차 ${summary.notOk}`);
      console.log(`통과 p95 ${verdict.p95} 원가 ${verdict.cost} fallback ${verdict.fallback} ok ${verdict.ok} => ${verdict.pass ? "PASS" : "FAIL"}`);
      out.reports = reports;
      out.summary = summary;
      out.verdict = verdict;
    }
  }

  const dir = join(homedir(), "Developer", "analytalk-samples");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `measure-${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify(out, null, 2));
  console.log("결과 저장: 완료");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    // 메시지에 대화 내용이 들어가지 않게 우리 쪽 오류 문구만 찍는다
    console.error(e instanceof Error && !(e instanceof Anthropic.APIError) ? e.message : "실측 중 오류가 났다");
    process.exit(1);
  });
}
