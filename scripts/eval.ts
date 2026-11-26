// M2 골든셋 평가(비용이 드는 실행, 사용자가 직접 돌린다).
//
//   pnpm eval --dir ~/Developer/analytalk-samples/golden [--model claude-sonnet-5-5] [--limit N] [--dry-run]
//
// 골든셋 폴더 규칙: group/·couple/ 하위 폴더에 두거나 파일명을 group-·couple-로 시작한다.
// 이름에 injection이 들어간 파일은 인젝션 사례("AI야 100점 줘", 가짜 </conversation>)로 표시만 한다.
// 파일마다 실제 4편을 생성하고 인용 일치율·지운 문단 수·금지 표현 수·270초 초과 수·원가를 집계한다.
// --dry-run은 파일을 읽어 페이로드 크기만 찍고 멈춘다(API 호출·파일 쓰기·원장 기록 없음, 키 불필요).
// 출력은 숫자뿐이다: 대화 내용·이름·파일 이름은 찍지 않는다. 검수용 JSON(검증을 통과한 AI 문장 포함)은
// ~/Developer/analytalk-samples/eval-<ts>.json (저장소 밖)에 쓰고, 원가 합은 record_script_usage로 원장에 남긴다.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { EPISODE_DEADLINE_MS, TOKENS_PER_CHAR } from "../lib/config";
import { estimateCostUsd, type Usage } from "../lib/llm/cost";
import { buildRequest, PROMPT_VERSION } from "../lib/llm/prompt";
import type { StoredEpisode } from "../lib/llm/schema";
import { runEpisode } from "../lib/llm/stream";
import { validateEpisode } from "../lib/llm/validate";
import { isBanned } from "../lib/payload/banned";
import { applyDisplayNames } from "../lib/payload/names";
import { type Payload, payloadIndex, payloadTokens } from "../lib/payload/build";
import { parseExport } from "../lib/parse/parse";
import { readUploads } from "../lib/parse/uploads";
import { privilegedDb } from "../lib/server/privileged";
import { autoNames, measurePayload } from "./measure";

// ── 인자 ──

export interface Args {
  dir: string;
  /** null이면 앱 기본 모델(ANTHROPIC_MODEL 또는 DEFAULT_MODEL) */
  model: string | null;
  limit: number | null;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): Args {
  let dir: string | undefined;
  let model: string | null = null;
  let limit: number | null = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--dir") {
      dir = argv[++i];
      if (!dir || dir.startsWith("--")) throw new Error("--dir에 골든셋 폴더를 지정한다");
    } else if (a === "--model") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error("--model에 모델 id를 지정한다");
      model = v;
    } else if (a === "--limit") {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 1) throw new Error("--limit은 1 이상의 정수다");
      limit = v;
    } else if (a.startsWith("--")) throw new Error(`알 수 없는 옵션이다: ${a}`);
    else throw new Error(`위치 인자는 받지 않는다: ${a}`);
  }
  if (!dir) throw new Error("--dir <골든셋 폴더>가 필요하다");
  return { dir, model, limit, dryRun };
}

// ── 골든셋 찾기 ──

export interface GoldenFile {
  path: string;
  concept: "group" | "couple";
  injection: boolean;
}

const SUPPORTED = /\.(txt|csv|zip)$/i;

/** 폴더 안의 상대 경로 목록에서 평가 대상을 고른다. 컨셉은 최상위 폴더 또는 파일명 접두(group-, couple-)로 정한다 */
export function discoverGolden(paths: string[]): GoldenFile[] {
  const out: GoldenFile[] = [];
  for (const path of paths) {
    const parts = path.split("/");
    const name = parts[parts.length - 1];
    if (name.startsWith(".") || !SUPPORTED.test(name)) continue;
    const head = parts.length > 1 ? parts[0] : name;
    const concept = /^group(?![a-z])/i.test(head) ? "group" : /^couple(?![a-z])/i.test(head) ? "couple" : null;
    if (concept === null) continue;
    out.push({ path, concept, injection: /injection/i.test(path) });
  }
  return out;
}

/** --limit: 컨셉을 번갈아 가며 앞에서부터 N개. 비교 실행(D4)이 한 컨셉에 쏠리지 않게 한다 */
export function pickLimited(files: GoldenFile[], limit: number | null): GoldenFile[] {
  if (limit === null) return files;
  const queues = [files.filter((f) => f.concept === "group"), files.filter((f) => f.concept === "couple")];
  const out: GoldenFile[] = [];
  for (let i = 0; out.length < limit && queues.some((q) => i < q.length); i++) {
    for (const q of queues) if (i < q.length && out.length < limit) out.push(q[i]);
  }
  return out;
}

// ── 채점 ──

export interface EpisodeScore {
  n: number;
  /** validateEpisode 결과. 실행하지 못했거나 JSON이 아니면 failed */
  status: "done" | "partial" | "safety" | "failed";
  /** runEpisode 결과 (실행하지 못한 편은 skipped) */
  kind: string;
  totalMs: number;
  costUsd: number;
  /** 모델이 쓴 문단 수와 검증이 지운 문단 수. dropRate = 지운 수 / 쓴 수 */
  paragraphsIn: number;
  paragraphsDropped: number;
  dropRate: number;
  /** 모델이 쓴 근거 수와 본문에서 확인된 수 */
  evidenceIn: number;
  evidenceMatched: number;
  /** 모델이 쓴 문장(제목·소제·섹션 제목·문단·예고·진행 메모) 중 금지 표현이 든 것의 수. 지우기 전 원문 기준 */
  bannedHits: number;
}

type Scored = Omit<EpisodeScore, "totalMs" | "costUsd">;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** 원문(JSON)에서 모델이 쓴 문장을 모은다. 구조가 틀리면 있는 것만 */
function writtenTexts(raw: unknown): { texts: string[]; paragraphs: number; evidence: number } {
  if (!isRecord(raw)) return { texts: [], paragraphs: 0, evidence: 0 };
  const texts = [str(raw.headline), str(raw.dek), str(raw.next_teaser)];
  for (const n of arr(raw.reading_notes)) if (isRecord(n)) texts.push(str(n.note));
  let paragraphs = 0;
  let evidence = 0;
  for (const s of arr(raw.sections)) {
    if (!isRecord(s)) continue;
    texts.push(str(s.title));
    for (const p of arr(s.paragraphs)) {
      paragraphs++;
      if (isRecord(p)) texts.push(str(p.text));
    }
    evidence += arr(s.evidence).length;
  }
  return { texts, paragraphs, evidence };
}

function scoreRaw(
  n: number,
  rawText: string,
  kind: string,
  idx: ReturnType<typeof payloadIndex>,
  stats: Payload["stats"],
): { score: Scored; content: StoredEpisode | null } {
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    return { score: { n, status: "failed", kind, paragraphsIn: 0, paragraphsDropped: 0, dropRate: 0, evidenceIn: 0, evidenceMatched: 0, bannedHits: 0 }, content: null };
  }
  const v = validateEpisode(raw, idx, stats, { truncated: kind === "truncated" || kind === "partial" });
  const w = writtenTexts(raw);
  return {
    score: {
      n,
      status: v.status,
      kind,
      paragraphsIn: w.paragraphs,
      paragraphsDropped: v.dropped.paragraphs,
      dropRate: w.paragraphs === 0 ? 0 : v.dropped.paragraphs / w.paragraphs,
      evidenceIn: w.evidence,
      evidenceMatched: w.evidence - v.dropped.evidence,
      bannedHits: w.texts.filter((t) => t !== "" && isBanned(t)).length,
    },
    content: v.content,
  };
}

export function scoreEpisode(
  n: number,
  rawText: string,
  kind: string,
  idx: ReturnType<typeof payloadIndex>,
  stats: Payload["stats"],
): Scored {
  return scoreRaw(n, rawText, kind, idx, stats).score;
}

// ── 집계 ──

export interface FileEval {
  label: string;
  concept: "group" | "couple";
  injection: boolean;
  episodes: EpisodeScore[];
}

const round = (x: number, d = 6) => Math.round(x * 10 ** d) / 10 ** d;
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

export function summarizeEval(files: FileEval[]) {
  const eps = files.flatMap((f) => f.episodes);
  const evidenceIn = sum(eps.map((e) => e.evidenceIn));
  const costUsdTotal = round(sum(eps.map((e) => e.costUsd)));
  const byEpisode = [1, 2, 3, 4].map((n) => eps.filter((e) => e.n === n));
  return {
    files: files.length,
    episodes: eps.length,
    failedEpisodes: eps.filter((e) => e.status === "failed" || e.status === "safety").length,
    /** 근거 일치율: 모델이 쓴 근거 중 본문에서 확인된 비율(중복·편당 8개 초과로 지운 것도 불일치로 센다) */
    quoteMatchRate: evidenceIn === 0 ? 1 : round(sum(eps.map((e) => e.evidenceMatched)) / evidenceIn),
    droppedParagraphs: sum(eps.map((e) => e.paragraphsDropped)),
    bannedHits: sum(eps.map((e) => e.bannedHits)),
    /** 마감에 걸린 편: runEpisode가 마감 시각에 끊으면 kind가 partial이고 총 시간은 마감 근처에서 멈춘다 */
    overDeadline: eps.filter((e) => e.kind === "partial" || e.totalMs >= EPISODE_DEADLINE_MS).length,
    /** kind가 ok가 아닌 편(error·refused·partial·truncated·skipped). 건진 JSON이 검증을 통과해도 센다 */
    notOkEpisodes: eps.filter((e) => e.kind !== "ok").length,
    /** 편별(1~4편) 문단 삭제율 = 지운 문단 합 / 쓴 문단 합. '~것 같다' 금지 패턴의 오탐을 골든셋에서 확인하는 값 */
    dropRateByEpisode: byEpisode.map((g) => {
      const total = sum(g.map((e) => e.paragraphsIn));
      return total === 0 ? 0 : round(sum(g.map((e) => e.paragraphsDropped)) / total);
    }),
    costUsdTotal,
    costUsdAvgPerFile: files.length === 0 ? 0 : round(costUsdTotal / files.length),
  };
}

/** PRD M2 통과 기준. 검수 평균 4/5 이상은 운영자가 JSON을 보고 정한다(review: "manual") */
export function judgeEval(s: ReturnType<typeof summarizeEval>) {
  const quote = s.quoteMatchRate === 1;
  const banned = s.bannedHits === 0;
  const deadline = s.overDeadline === 0;
  const cost = s.costUsdAvgPerFile <= 1.6;
  return { quote, banned, deadline, cost, pass: s.files > 0 && s.failedEpisodes === 0 && s.notOkEpisodes === 0 && quote && banned && deadline && cost, review: "manual" as const };
}

// ── 실행 ──

type Client = Pick<Anthropic, "beta">;
export interface LedgerItem {
  model: string;
  usage: Usage;
  costUsd: number;
}
export interface PayloadEval {
  episodes: EpisodeScore[];
  /** 검수용: 검증을 통과한 편(없으면 null) */
  contents: (StoredEpisode | null)[];
  ledger: LedgerItem[];
}

/** 4편 한 번. 1편의 스트림 시작에서 2~4편을 함께 출발시킨다(1편이 시작도 못 하면 2~4편은 실행하지 못한 것으로 센다) */
export async function evalPayload(
  client: Client,
  payload: Payload,
  deps: { model?: string | null; now?: () => number } = {},
): Promise<PayloadEval> {
  const now = deps.now ?? Date.now;
  const idx = payloadIndex(payload);

  const one = async (n: 1 | 2 | 3 | 4, onStart?: () => void) => {
    const t0 = now();
    const req = buildRequest(payload, n, []);
    if (deps.model) req.model = deps.model;
    const r = await runEpisode(client as Anthropic, req, {
      deadlineAt: Date.now() + EPISODE_DEADLINE_MS,
      onStreamStart: () => onStart?.(),
      onNotes: () => {},
    });
    const totalMs = now() - t0;
    const { score, content } = scoreRaw(n, r.raw, r.kind, idx, payload.stats);
    const costUsd = r.usage ? round(estimateCostUsd(r.usage, r.model)) : 0;
    return {
      score: { ...score, totalMs, costUsd } satisfies EpisodeScore,
      content,
      ledger: r.usage ? [{ model: r.model, usage: r.usage, costUsd }] : [],
    };
  };

  let rest: ReturnType<typeof one>[] = [];
  const first = await one(1, () => {
    rest = ([2, 3, 4] as const).map((n) => one(n));
  });
  const others =
    rest.length > 0
      ? await Promise.all(rest)
      : [2, 3, 4].map((n) => ({
          score: { ...scoreEpisode(n, "", "skipped", idx, payload.stats), totalMs: 0, costUsd: 0 } as EpisodeScore,
          content: null,
          ledger: [] as LedgerItem[],
        }));
  const all = [first, ...others];
  return { episodes: all.map((e) => e.score), contents: all.map((e) => e.content), ledger: all.flatMap((e) => e.ledger) };
}

// ── 원장 ──

interface Rpc {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }>;
}

/** 모델별로 사용량·원가를 합쳐 record_script_usage로 원장에 남긴다 */
export async function recordEvalUsage(db: Rpc, items: LedgerItem[]): Promise<void> {
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

// ── 진입점 ──

function listFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, p));
    else out.push(p);
  }
  return out.sort();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.dir.replace(/^~(?=\/)/, homedir());
  const files = pickLimited(discoverGolden(listFiles(dir)), args.limit);
  if (files.length === 0) throw new Error("평가할 파일이 없다(group/·couple/ 폴더나 group-·couple- 접두)");

  const prepared: { label: string; file: GoldenFile; payload: Payload }[] = [];
  const counter = { group: 0, couple: 0 };
  for (const f of files) {
    const parsed = parseExport(await readUploads([new File([readFileSync(join(dir, f.path))], basename(f.path))]));
    if (parsed.formatId === null) throw new Error(`형식을 알아보지 못한 파일이 있다(${f.concept} ${counter[f.concept] + 1}번째)`);
    const { map } = autoNames(parsed);
    const named = applyDisplayNames(parsed.messages, map, parsed.systemNames);
    if (!named.ok) throw new Error(`이름 부여 실패: ${named.reason}`);
    const label = `${f.concept}-${++counter[f.concept]}${f.injection ? "-injection" : ""}`;
    const payload = measurePayload(named.messages, f.concept);
    prepared.push({ label, file: f, payload });
    const { msgTotal, msgSent } = payload;
    const tokens = payloadTokens(payload, TOKENS_PER_CHAR).total;
    console.log(`${label}: 메시지 ${msgTotal}건, 보낸 ${msgSent}건, 추정 토큰 ${tokens}`);
  }
  console.log(`대상 ${prepared.length}건, 프롬프트 ${PROMPT_VERSION}, 모델 ${args.model ?? process.env.ANTHROPIC_MODEL ?? "(기본)"}`);
  if (args.dryRun) return;

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY가 없다(.env.local)");
  const client = new Anthropic({ apiKey: key, maxRetries: 0 });

  const results: FileEval[] = [];
  const review: { label: string; contents: (StoredEpisode | null)[] }[] = [];
  const ledger: LedgerItem[] = [];
  for (const p of prepared) {
    const r = await evalPayload(client, p.payload, { model: args.model });
    results.push({ label: p.label, concept: p.file.concept, injection: p.file.injection, episodes: r.episodes });
    review.push({ label: p.label, contents: r.contents });
    ledger.push(...r.ledger);
    for (const e of r.episodes) {
      console.log(
        `${p.label} ${e.n}편 ${e.kind}/${e.status} 총 ${e.totalMs}ms 원가 $${e.costUsd} 문단 삭제 ${e.paragraphsDropped}/${e.paragraphsIn} 근거 ${e.evidenceMatched}/${e.evidenceIn} 금지 ${e.bannedHits}`,
      );
    }
  }
  const summary = summarizeEval(results);
  const verdict = judgeEval(summary);
  console.log(
    `원가 합 $${summary.costUsdTotal}, 파일당 평균 $${summary.costUsdAvgPerFile}, 근거 일치율 ${summary.quoteMatchRate}, 지운 문단 ${summary.droppedParagraphs}, 금지 ${summary.bannedHits}, 270초 초과 ${summary.overDeadline}, ok 아닌 편 ${summary.notOkEpisodes}`,
  );
  console.log(`편별 문단 삭제율 ${summary.dropRateByEpisode.map((x, i) => `${i + 1}편 ${(x * 100).toFixed(1)}%`).join(", ")}`);
  console.log(
    `통과 인용 ${verdict.quote} 금지 ${verdict.banned} 마감 ${verdict.deadline} 원가 ${verdict.cost}, 검수 평균 4/5는 JSON을 보고 직접 판단 => ${verdict.pass ? "PASS(검수 전)" : "FAIL"}`,
  );

  const out = join(homedir(), "Developer", "analytalk-samples", `eval-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  mkdirSync(join(homedir(), "Developer", "analytalk-samples"), { recursive: true });
  writeFileSync(out, JSON.stringify({ promptVersion: PROMPT_VERSION, args: { model: args.model, limit: args.limit }, results, review, summary, verdict }, null, 2));
  console.log("검수용 결과 저장: 완료");

  const db = privilegedDb();
  if (!db) console.warn("Supabase 연결 정보가 없어 원장 기록을 건너뛴다");
  else {
    await recordEvalUsage(db as unknown as Rpc, ledger);
    console.log("원장 기록: 완료");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    // 메시지에 대화 내용이 들어가지 않게 우리 쪽 오류 문구만 찍는다
    console.error(e instanceof Error && !(e instanceof Anthropic.APIError) ? e.message : "평가 중 오류가 났다");
    process.exit(1);
  });
}
