// M0 실측(비용이 드는 실행, 사용자가 직접 돌린다).
//
//   pnpm measure <샘플파일> [--concept group|couple] [--runs 2] [--dry-run]
//
// 파싱 → 표시 이름 자동 부여(P1…) → buildPayloadForBudget → countTokens → 1편 실행, 그 스트림 시작에서 2~4편 병렬 실행.
// --dry-run은 페이로드를 만들고 토큰 추정치를 찍은 뒤 멈춘다(API 호출·파일 쓰기 없음, 키 불필요).
// 출력은 숫자뿐이다: 대화 내용·이름·파일 이름·모델 원문은 찍지도 저장하지도 않는다.
// 결과 JSON은 ~/Developer/analytalk-samples/measure-<ts>.json (저장소 밖)에 쓴다.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { PROMPT_RESERVE_TOKENS, TOKENS_PER_CHAR } from "../lib/config";
import { DEFAULT_TONE } from "../lib/llm/concepts";
import { modelSettings } from "../lib/llm/settings";
import { estimateCostUsd } from "../lib/llm/cost";
import { buildRequest } from "../lib/llm/prompt";
import { runEpisode } from "../lib/llm/stream";
import { validateEpisode } from "../lib/llm/validate";
import { applyDisplayNames, type NameMap } from "../lib/payload/names";
import { buildPayloadForBudget, type Payload, payloadIndex, payloadTokens } from "../lib/payload/build";
import { type ChatMessage, parseExport } from "../lib/parse/parse";
import { readUploads } from "../lib/parse/uploads";

// ── 인자 ──

export interface Args {
  file: string;
  concept: "group" | "couple";
  runs: number;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): Args {
  const files: string[] = [];
  let concept: Args["concept"] = "group";
  let runs = 1;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--concept") {
      const v = argv[++i];
      if (v !== "group" && v !== "couple") throw new Error("--concept은 group 또는 couple이다");
      concept = v;
    } else if (a === "--runs") {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 1) throw new Error("--runs는 1 이상의 정수다");
      runs = v;
    } else if (a.startsWith("--")) throw new Error(`알 수 없는 옵션이다: ${a}`);
    else files.push(a);
  }
  if (files.length === 0) throw new Error("샘플 파일을 지정한다");
  if (files.length > 1) throw new Error("샘플 파일은 하나만 지정한다");
  return { file: files[0], concept, runs, dryRun };
}

// ── 이름 ──

/** 발신자·알림 속 이름에 P1, P2…를 처음 나온 순서로 준다 */
export function autoNames(p: {
  participants: string[];
  systemNames: string[];
  messages: { sender: string | null }[];
}): { map: NameMap } {
  const map: NameMap = {};
  for (const n of [...p.participants, ...p.systemNames]) {
    if (n !== "" && !Object.hasOwn(map, n)) map[n] = `P${Object.keys(map).length + 1}`;
  }
  return { map };
}

// ── 집계 ──

export interface EpisodeMeasure {
  n: number;
  /** 요청부터 message_start까지. 응답 시작 전에 끝났으면 null */
  ttftMs: number | null;
  totalMs: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  /** validateEpisode 결과. 실행하지 못했거나 JSON이 아니면 failed */
  status: "done" | "partial" | "safety" | "failed" | "skipped";
  /** runEpisode 결과 */
  kind: string;
}

export interface RunMeasure {
  episodes: EpisodeMeasure[];
}

const round = (x: number, d = 6) => Math.round(x * 10 ** d) / 10 ** d;

/** nearest-rank 백분위수. 빈 배열은 0 */
export function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

export function summarize(runs: RunMeasure[]) {
  const eps = runs.flatMap((r) => r.episodes).filter((e) => e.status !== "skipped");
  const costUsdPerRun = runs.map((r) => round(r.episodes.reduce((s, e) => s + e.costUsd, 0)));
  const later = eps.filter((e) => e.n > 1);
  return {
    runs: runs.length,
    costUsdPerRun,
    costUsdTotal: round(costUsdPerRun.reduce((s, c) => s + c, 0)),
    p95TotalMs: percentile(eps.map((e) => e.totalMs), 0.95),
    p95TtftMs: percentile(eps.flatMap((e) => (e.ttftMs === null ? [] : [e.ttftMs])), 0.95),
    /** 2~4편이 모두 캐시를 읽었는지(실행이 하나도 없으면 false) */
    cacheReadOk: later.length > 0 && later.every((e) => e.cacheReadTokens > 0),
    skipped: runs.flatMap((r) => r.episodes).filter((e) => e.status === "skipped").length,
  };
}

/** Task 8 통과 기준: 편당 p95 240초 이하, 2~4편 cache_read > 0, 한 번의 원가 $0.92~$1.70 */
export function judge(s: ReturnType<typeof summarize>) {
  const p95 = s.p95TotalMs <= 240_000;
  const cache = s.cacheReadOk;
  const cost = s.costUsdPerRun.length > 0 && s.costUsdPerRun.every((c) => c >= 0.92 && c <= 1.7);
  return { p95, cache, cost, pass: p95 && cache && cost && s.skipped === 0 };
}

// ── 실행 ──

type Client = Pick<Anthropic, "beta">;

/** 요청의 입력 토큰을 센다(system + 데이터 메시지). 편 지시(messages[1])는 편마다 달라서 뺀다 */
export async function measureTokens(client: Client, payload: Payload): Promise<{ inputTokens: number; chars: number }> {
  const req = buildRequest(payload, 1, []);
  const system = typeof req.system === "string" ? req.system : "";
  const first = req.messages[0];
  const data = typeof first.content === "string" ? first.content : first.content.map((b) => ("text" in b ? b.text : "")).join("");
  const r = await client.beta.messages.countTokens({ model: req.model, system, messages: [first] });
  return { inputTokens: r.input_tokens, chars: system.length + data.length };
}

/** 4편 한 번. 1편의 스트림 시작에서 2~4편을 함께 출발시킨다(1편이 시작도 못 하면 2~4편은 skipped) */
export async function measureRun(client: Client, payload: Payload, deps: { now?: () => number } = {}): Promise<RunMeasure> {
  const now = deps.now ?? Date.now;
  const idx = payloadIndex(payload);

  const one = async (n: 1 | 2 | 3 | 4, onStart?: () => void): Promise<EpisodeMeasure> => {
    const t0 = now();
    let ttft: number | null = null;
    const req = buildRequest(payload, n, []);
    const r = await runEpisode(client as Anthropic, req, {
      deadlineAt: Date.now() + 270_000,
      onStreamStart: () => {
        ttft = now() - t0;
        onStart?.();
      },
      onNotes: () => {},
    });
    const totalMs = now() - t0;
    let status: EpisodeMeasure["status"] = "failed";
    try {
      status = validateEpisode(JSON.parse(r.raw), idx, payload.stats, { truncated: r.kind === "truncated" || r.kind === "partial" }).status;
    } catch {
      // JSON이 아니면 failed
    }
    const u = r.usage;
    return {
      n,
      ttftMs: ttft,
      totalMs,
      outputTokens: u?.output_tokens ?? 0,
      cacheReadTokens: u?.cache_read_input_tokens ?? 0,
      cacheCreationTokens: u?.cache_creation_input_tokens ?? 0,
      costUsd: u ? round(estimateCostUsd(u, r.model)) : 0,
      status,
      kind: r.kind,
    };
  };

  let rest: Promise<EpisodeMeasure>[] = [];
  const first = await one(1, () => {
    rest = ([2, 3, 4] as const).map((n) => one(n));
  });
  const others = rest.length > 0 ? await Promise.all(rest) : [2, 3, 4].map((n) => skipped(n));
  return { episodes: [first, ...others] };
}

const skipped = (n: number): EpisodeMeasure => ({
  n, ttftMs: null, totalMs: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, status: "skipped", kind: "skipped",
});

// ── 진입점 ──

/** 입력 예산(modelSettings().inputBudget)에서 통계 요약·프롬프트 몫(PROMPT_RESERVE_TOKENS)을 빼고 맞춘 페이로드 */
export function measurePayload(messages: ChatMessage[], concept: Args["concept"]): Payload {
  return buildPayloadForBudget({
    messages,
    concept,
    tone: DEFAULT_TONE,
    kind: concept === "couple" ? "pair" : "group",
    inputBudget: modelSettings().inputBudget,
    tokensPerChar: TOKENS_PER_CHAR,
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const bytes = readFileSync(args.file);
  const parsed = parseExport(await readUploads([new File([bytes], basename(args.file))]));
  if (parsed.formatId === null) throw new Error("형식을 알아보지 못했다");
  const { map } = autoNames(parsed);
  const named = applyDisplayNames(parsed.messages, map, parsed.systemNames);
  if (!named.ok) throw new Error(`이름 부여 실패: ${named.reason}`);

  const payload = measurePayload(named.messages, args.concept);
  const est = payloadTokens(payload, TOKENS_PER_CHAR);
  console.log(
    `메시지 ${payload.msgTotal}건, 보낸 ${payload.msgSent}건, 추정 토큰 ${est.total}(본문 ${est.text}) + 프롬프트 몫 ${PROMPT_RESERVE_TOKENS}, 예산 ${modelSettings().inputBudget}`,
  );
  if (args.dryRun) return;

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY가 없다(.env.local)");
  const client = new Anthropic({ apiKey: key, maxRetries: 0 });

  const tokens = await measureTokens(client, payload);
  const tokensPerChar = round(tokens.inputTokens / tokens.chars, 4);
  console.log(`countTokens ${tokens.inputTokens}, 글자 ${tokens.chars}, 글자당 토큰 ${tokensPerChar}`);

  const runs: RunMeasure[] = [];
  for (let i = 0; i < args.runs; i++) {
    const r = await measureRun(client, payload);
    runs.push(r);
    for (const e of r.episodes) {
      console.log(
        `run ${i + 1} ${e.n}편 ttft ${e.ttftMs ?? "-"}ms 총 ${e.totalMs}ms 출력 ${e.outputTokens} cache_read ${e.cacheReadTokens} 원가 $${e.costUsd} ${e.kind}/${e.status}`,
      );
    }
  }
  const summary = summarize(runs);
  const verdict = judge(summary);
  console.log(`원가 합 $${summary.costUsdTotal} (회차별 ${summary.costUsdPerRun.map((c) => `$${c}`).join(", ")}), p95 총 ${summary.p95TotalMs}ms`);
  console.log(`통과 p95 ${verdict.p95} cache ${verdict.cache} cost ${verdict.cost} => ${verdict.pass ? "PASS" : "FAIL"}`);

  const dir = join(homedir(), "Developer", "analytalk-samples");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `measure-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(out, JSON.stringify({ args: { concept: args.concept, runs: args.runs }, tokens: { ...tokens, tokensPerChar }, runs, summary, verdict }, null, 2));
  console.log("결과 저장: 완료");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    // 메시지에 대화 내용이 들어가지 않게 우리 쪽 오류 문구만 찍는다
    console.error(e instanceof Error && !(e instanceof Anthropic.APIError) ? e.message : "실측 중 오류가 났다");
    process.exit(1);
  });
}
