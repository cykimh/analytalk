// 브라우저가 AI 연재를 요청한다: [AI 연재 만들기](POST /api/conversations)와 [다시 쓰기](POST /api/episodes/retry).
// 페이로드는 이 두 요청의 본문으로만 나가고, 재시도용으로 이 브라우저의 IndexedDB에 둔다(lib/client/idb).
import type { Payload } from "@/lib/payload/build";

export const SUBMIT_TEXT = {
  paused: "이번 달 AI 마감",
  inviteLimit: "이 코드의 이번 달 횟수를 다 썼어요",
  dayFull: "오늘 분량이 다 찼어요. 내일 다시 와 주세요",
  tooLong: "대화가 너무 길어서 AI에게 보내지 못했어요. 잠시 뒤 다시 시도해 주세요.",
  reupload: "같은 파일을 다시 올려 주세요",
  notStartable: "이 편은 지금 다시 쓸 수 없어요. 화면을 새로 고쳐 주세요.",
  session: "초대 코드 확인이 만료됐어요. 처음 화면에서 코드를 다시 넣어 주세요.",
  notReady: "아직 AI 연재를 만들 준비가 안 됐어요. 잠시 뒤 다시 시도해 주세요.",
  generic: "보내지 못했어요. 잠시 뒤 다시 시도해 주세요.",
} as const;

export type SubmitResult = { ok: true } | { ok: false; message: string };

const failed = (message: string) => ({ ok: false as const, message });

async function readBody(res: Response): Promise<Record<string, unknown>> {
  const body: unknown = await res.json().catch(() => null);
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
}

/** 두 요청에 같은 뜻으로 오는 응답의 문구 */
function commonText(status: number, body: Record<string, unknown>): string {
  if (status === 423) return SUBMIT_TEXT.paused;
  if (status === 429) return body.reason === "invite_limit" ? SUBMIT_TEXT.inviteLimit : SUBMIT_TEXT.dayFull;
  if (status === 401) return SUBMIT_TEXT.session;
  if (status === 400 && body.error === "bad_payload") return SUBMIT_TEXT.reupload;
  if (status === 503) return SUBMIT_TEXT.notReady;
  return SUBMIT_TEXT.generic;
}

/** 같은 출처 JSON POST */
export const postJson = (url: string) => (body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export interface CreateDeps {
  post: (payload: Payload) => Promise<Response>;
  /** 413 {maxTokens} 뒤 한 번 다시 만든다. 화면은 retryBuildInput(첫 입력, maxTokens)로 buildInWorker를 부른다 */
  rebuild: (maxTokens: number) => Promise<Payload>;
  save: (id: string, payload: Payload) => Promise<void>;
}

/**
 * 202(새 연재)·200(같은 요청이 이미 있음) → 서버가 받은 페이로드를 저장하고 id.
 * 413이면 한 번만 다시 만들어 보낸다(R7). 두 번째 413이나 다시 만들기 실패는 더 줄이지 않고 오류 문구다
 */
export async function createSeries(payload: Payload, deps: CreateDeps): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  let current = payload;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await deps.post(current);
    } catch {
      return failed(SUBMIT_TEXT.generic);
    }
    const body = await readBody(res);
    if (res.status === 202 || res.status === 200) {
      if (typeof body.id !== "string" || body.id === "") return failed(SUBMIT_TEXT.generic);
      // 저장하지 못해도(사생활 보호 모드 등) 연재는 서버에서 계속 쓴다. [다시 쓰기]만 파일을 다시 올려야 한다
      await deps.save(body.id, current).catch(() => undefined);
      return { ok: true, id: body.id };
    }
    if (res.status === 413) {
      const { maxTokens } = body;
      if (attempt > 0 || typeof maxTokens !== "number" || !(maxTokens > 0)) return failed(SUBMIT_TEXT.tooLong);
      try {
        current = await deps.rebuild(maxTokens);
      } catch {
        // 줄인 예산에 날짜 헤더·줄 머리조차 들어가지 않는 경우 등
        return failed(SUBMIT_TEXT.tooLong);
      }
      continue;
    }
    return failed(commonText(res.status, body));
  }
}

export interface RetryDeps {
  load: (id: string) => Promise<Payload | null>;
  post: (body: { id: string; n: number; payload: Payload }) => Promise<Response>;
}

/** 이 브라우저에 둔 페이로드로 n편을 다시 쓴다. 없으면(24시간 지남·다른 브라우저) 보내지 않는다 */
export async function retryEpisode(id: string, n: number, deps: RetryDeps): Promise<SubmitResult> {
  const payload = await deps.load(id).catch(() => null);
  if (!payload) return failed(SUBMIT_TEXT.reupload);
  let res: Response;
  try {
    res = await deps.post({ id, n, payload });
  } catch {
    return failed(SUBMIT_TEXT.generic);
  }
  if (res.status === 202) return { ok: true };
  const body = await readBody(res);
  if (res.status === 409) return failed(body.error === "payload_mismatch" ? SUBMIT_TEXT.reupload : SUBMIT_TEXT.notStartable);
  return failed(commonText(res.status, body));
}
