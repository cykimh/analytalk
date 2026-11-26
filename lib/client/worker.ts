// 화면 쪽에서 parse.worker를 부른다. 워커는 처음 부를 때 하나 만들어 계속 쓴다.
// 파일·메시지는 postMessage로 워커에 넘길 뿐 브라우저 밖으로 나가지 않는다.
import type { Payload } from "@/lib/payload/build";
import type { ParseResult } from "@/lib/parse/parse";
import type { BuildRequest, RenameInput, RenameResult, WorkerRequest, WorkerResponse } from "./parse.worker";

export type { BuildRequest, RenameInput, RenameResult } from "./parse.worker";

type BudgetInput = Extract<BuildRequest, { inputBudget: number }>;

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

/** applyDisplayNames + dropSafetyFlagged: 발신자 이름만 바꾸고 뺀 멤버·봇·위험 신호 메시지를 거른다 */
export function renameInWorker(input: RenameInput): Promise<RenameResult> {
  return call({ op: "rename", input });
}

/**
 * 이름 정리를 마친 메시지로 페이로드를 만든다(stats 포함).
 * 입력 예산(inputBudget)은 서버가 알려 준 값(modelSettings)이고, 413 뒤에는 retryBuildInput이 줄인 inputBudget으로 다시 만든다
 */
export function buildInWorker(input: BuildRequest): Promise<Payload> {
  return call({ op: "build", input });
}

/**
 * 413 { maxTokens } 뒤 한 번만 다시 만들 입력. maxTokens는 서버가 어림한 "입력 예산 단위"(본문 + 통계 + 프롬프트 몫)라
 * 첫 입력의 inputBudget만 floor(maxTokens × 0.95)로 바꿔 buildPayloadForBudget에 다시 넘긴다
 */
export function retryBuildInput(first: BudgetInput, maxTokens: number): BudgetInput {
  return { ...first, inputBudget: Math.floor(maxTokens * 0.95) };
}
