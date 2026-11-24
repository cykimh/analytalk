// 파싱·이름 정리·페이로드 만들기를 돌리는 Web Worker. 원본 파일과 파싱 결과는 이 브라우저 안에만 있다.
// 요청 {id, op, …} → 응답 {id, ok, result | error}. 화면 쪽 호출은 lib/client/worker.ts가 맡는다.
import { buildPayload, buildPayloadForBudget, type Payload } from "@/lib/payload/build";
import { applyDisplayNames, findNameLeftovers, type NameError, type NameLeftover, type NameMap } from "@/lib/payload/names";
import { safetySignal } from "@/lib/payload/safety";
import { type ChatMessage, type ParseResult, parseExport } from "@/lib/parse/parse";
import { readUploads } from "@/lib/parse/uploads";

export interface RenameInput {
  messages: ChatMessage[];
  map: NameMap;
  systemNames: string[];
  /** [같은 사람]으로 합친 원래 이름 묶음 */
  merged: string[][];
  /** 이름을 바꾼 뒤에도 남은 원래 이름 조각 → 그 자리에 넣을 표시 이름. 글자 그대로(대소문자 무시) 바꾼다 */
  fixes: Record<string, string>;
}

export type RenameResult =
  | { ok: true; messages: ChatMessage[]; leftovers: NameLeftover[]; safety: ReturnType<typeof safetySignal> }
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

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 사람이 보낸 text 메시지 본문에서 fixes의 조각을 바꾼다(긴 조각부터, 대소문자 무시) */
function applyFixes(messages: ChatMessage[], fixes: Record<string, string>): ChatMessage[] {
  const pieces = Object.keys(fixes).filter((p) => p !== "");
  if (pieces.length === 0) return messages;
  const re = new RegExp([...pieces].sort((a, b) => [...b].length - [...a].length).map(escapeRe).join("|"), "giu");
  const folded = new Map(pieces.map((p) => [p.toLowerCase(), fixes[p]]));
  // 보통은 소문자로 바로 찾고, toLowerCase와 정규식의 대소문자 접기가 다른 글자만 하나씩 비교한다
  const replace = (hit: string) => {
    const direct = folded.get(hit.toLowerCase());
    if (direct !== undefined) return direct;
    const piece = pieces.find((p) => new RegExp(`^${escapeRe(p)}$`, "iu").test(hit));
    return piece === undefined ? hit : fixes[piece];
  };
  return messages.map((m) => (m.sender !== null && m.kind === "text" ? { ...m, text: m.text.replace(re, replace) } : m));
}

function rename(input: RenameInput): RenameResult {
  const named = applyDisplayNames(input.messages, input.map, input.systemNames, input.merged);
  if (!named.ok) return named;
  const messages = applyFixes(named.messages, input.fixes);
  return { ok: true, messages, leftovers: findNameLeftovers(messages, input.map), safety: safetySignal(messages) };
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
