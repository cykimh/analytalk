// 화면 쪽에서 parse.worker를 부른다. 워커는 처음 부를 때 하나 만들어 계속 쓴다.
// 파일·메시지는 postMessage로 워커에 넘길 뿐 브라우저 밖으로 나가지 않는다.
import type { Payload } from "@/lib/payload/build";
import type { ParseResult } from "@/lib/parse/parse";
import type { BuildRequest, RenameInput, RenameResult, WorkerRequest, WorkerResponse } from "./parse.worker";

export type { BuildRequest, RenameInput, RenameResult } from "./parse.worker";

type BudgetInput = Extract<BuildRequest, { inputBudget: number }>;
type TokenInput = Extract<BuildRequest, { tokenBudget: number }>;

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./parse.worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const res = e.data;
    const call = pending.get(res.id);
    if (!call) return;
    pending.delete(res.id);
    if (res.ok) call.resolve(res.result);
    else call.reject(new Error(res.error));
  };
  // 워커가 죽으면 기다리던 호출을 모두 실패로 끝내고, 다음 호출 때 새로 만든다
  w.onerror = () => {
    for (const call of pending.values()) call.reject(new Error("브라우저에서 대화를 읽지 못했어요"));
    pending.clear();
    w.terminate();
    if (worker === w) worker = null;
  };
  return (worker = w);
}

function call<T>(req: WorkerRequest): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    getWorker().postMessage({ id, ...req });
  });
}

/** readUploads → parseExport */
export function parseInWorker(files: File[]): Promise<ParseResult> {
  return call({ op: "parse", files });
}

/** applyDisplayNames → 남은 조각 바꾸기(fixes) → findNameLeftovers */
export function renameInWorker(input: RenameInput): Promise<RenameResult> {
  return call({ op: "rename", input });
}

/**
 * 이름 정리를 마친 메시지로 페이로드를 만든다(stats 포함).
 * 첫 요청은 { inputBudget: INPUT_TOKEN_BUDGET }(buildPayloadForBudget), 413 뒤에는 retryBuildInput의 { tokenBudget }(buildPayload)
 */
export function buildInWorker(input: BuildRequest): Promise<Payload> {
  return call({ op: "build", input });
}

/**
 * 413 { maxTokens } 뒤 한 번만 다시 만들 입력. maxTokens는 클라이언트 추정 단위(anchors + transcript)라
 * tokenBudget = floor(maxTokens × 0.95)로 그대로 쓴다(Task 13이 buildInWorker에 넘긴다)
 */
export function retryBuildInput(first: BudgetInput, maxTokens: number): TokenInput {
  const { inputBudget: _, ...rest } = first;
  return { ...rest, tokenBudget: Math.floor(maxTokens * 0.95) };
}
