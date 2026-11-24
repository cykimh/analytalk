// 파싱·이름 정리·페이로드 만들기를 돌리는 Web Worker. 원본 파일과 파싱 결과는 이 브라우저 안에만 있다.
// 요청 {id, op, …} → 응답 {id, ok, result | error}. 화면 쪽 호출은 lib/client/worker.ts가 맡는다.
import { buildPayload, buildPayloadForBudget, type Payload } from "@/lib/payload/build";
import { applyDisplayNames, applyNameFixes, findNameLeftovers, type NameError, type NameLeftover, type NameMap } from "@/lib/payload/names";
import { type ChatMessage, type ParseResult, parseExport } from "@/lib/parse/parse";
import { readUploads } from "@/lib/parse/uploads";

export interface RenameInput {
  messages: ChatMessage[];
  map: NameMap;
  systemNames: string[];
  /** [같은 사람]으로 합친 원래 이름 묶음 */
  merged: string[][];
  /** 이름을 바꾼 뒤에도 남은 원래 이름 조각 → 그 자리에 넣을 표시 이름. findNameLeftovers와 같은 방식으로 찾아 바꾼다(applyNameFixes) */
  fixes: Record<string, string>;
}

export type RenameResult =
  | { ok: true; messages: ChatMessage[]; leftovers: NameLeftover[] }
  | { ok: false; reason: NameError };

/** 첫 요청은 inputBudget(buildPayloadForBudget), 413 뒤 한 번 다시 만들 때는 tokenBudget(buildPayload) */
export type BuildRequest = Parameters<typeof buildPayload>[0] | Parameters<typeof buildPayloadForBudget>[0];

export type WorkerRequest = { op: "parse"; files: File[] } | { op: "rename"; input: RenameInput } | { op: "build"; input: BuildRequest };
export type WorkerResult<R extends WorkerRequest> = R extends { op: "parse" }
  ? ParseResult
  : R extends { op: "rename" }
    ? RenameResult
    : Payload;
export type WorkerResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

function rename(input: RenameInput): RenameResult {
  const named = applyDisplayNames(input.messages, input.map, input.systemNames, input.merged);
  if (!named.ok) return named;
  const messages = applyNameFixes(named.messages, input.fixes, input.map);
  // 안전 신호는 보낼 메시지가 정해진 뒤(페이로드를 만든 뒤) 화면이 sentSafetySignal로 본다
  return { ok: true, messages, leftovers: findNameLeftovers(messages, input.map) };
}

export async function runOp<R extends WorkerRequest>(req: R): Promise<WorkerResult<R>>;
export async function runOp(req: WorkerRequest): Promise<ParseResult | RenameResult | Payload> {
  switch (req.op) {
    case "parse":
      return parseExport(await readUploads(req.files));
    case "rename":
      return rename(req.input);
    case "build":
      return "inputBudget" in req.input ? buildPayloadForBudget(req.input) : buildPayload(req.input);
  }
}

/** 던진 오류는 문구만 돌려준다(화면에 보여 줄 뿐 어디에도 남기지 않는다) */
export async function handleMessage(msg: { id: number } & WorkerRequest): Promise<WorkerResponse> {
  try {
    return { id: msg.id, ok: true, result: await runOp(msg) };
  } catch (error) {
    return { id: msg.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Worker 안에서만 메시지를 받는다(테스트는 위 함수를 바로 부른다)
if ("WorkerGlobalScope" in globalThis) {
  const scope = globalThis as unknown as {
    addEventListener(type: "message", listener: (e: MessageEvent<{ id: number } & WorkerRequest>) => void): void;
    postMessage(message: WorkerResponse): void;
  };
  scope.addEventListener("message", (e) => {
    void handleMessage(e.data).then((res) => scope.postMessage(res));
  });
}
