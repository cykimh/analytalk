// 파싱·이름 정리·페이로드 만들기를 돌리는 Web Worker. 원본 파일과 파싱 결과는 이 브라우저 안에만 있다.
// 요청 {id, op, …} → 응답 {id, ok, result | error}. 화면 쪽 호출은 lib/client/worker.ts가 맡는다.
import { buildPayload, buildPayloadForBudget, type Payload } from "@/lib/payload/build";
import { applyDisplayNames, isBotOrUnknown, type NameError, type NameMap } from "@/lib/payload/names";
import { dropSafetyFlagged } from "@/lib/payload/safety";
import { type ChatMessage, type ParseResult, parseExport } from "@/lib/parse/parse";
import { readUploads } from "@/lib/parse/uploads";

export interface RenameInput {
  messages: ChatMessage[];
  map: NameMap;
  /** [같은 사람]으로 합친 원래 이름 묶음 */
  merged: string[][];
  /** 분석에서 뺀 원래 이름(합친 사람 포함). 이 사람들과 봇·알 수 없음의 메시지는 결과에 없다 */
  excluded: string[];
}

/**
 * safetyDropped: 위험 신호(자해·폭력) 때문에 뺀 메시지 수. 보낼 내용 확인 화면이 한 줄로 알린다.
 * hiddenNames(v2.9): 뺀 멤버와 봇·알 수 없음의 원래 이름. 페이로드를 만들 때 넘겨 자주 쓰는 단어에서 거른다(페이로드에는 싣지 않는다)
 */
export type RenameResult = { ok: true; messages: ChatMessage[]; safetyDropped: number; hiddenNames: string[] } | { ok: false; reason: NameError };

/** 첫 요청은 inputBudget(buildPayloadForBudget), 413 뒤 한 번 다시 만들 때는 tokenBudget(buildPayload) */
export type BuildRequest = Parameters<typeof buildPayload>[0] | Parameters<typeof buildPayloadForBudget>[0];

export type WorkerRequest = { op: "parse"; files: File[] } | { op: "rename"; input: RenameInput } | { op: "build"; input: BuildRequest };
export type WorkerResult<R extends WorkerRequest> = R extends { op: "parse" }
  ? ParseResult
  : R extends { op: "rename" }
    ? RenameResult
    : Payload;
export type WorkerResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

/** 이름 정리(뺀 멤버·봇 제외) 뒤 위험 신호가 있는 메시지를 뺀다. 막지 않는다 */
function rename(input: RenameInput): RenameResult {
  const r = applyDisplayNames(input.messages, { map: input.map, merged: input.merged, excluded: input.excluded });
  if (!r.ok) return r;
  const { messages, dropped } = dropSafetyFlagged(r.messages);
  const bots = input.messages.flatMap((m) => (m.sender !== null && isBotOrUnknown(m.sender) ? [m.sender] : []));
  return { ok: true, messages, safetyDropped: dropped, hiddenNames: [...new Set([...input.excluded, ...bots])] };
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
