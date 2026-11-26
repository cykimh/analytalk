// 재시도용 페이로드를 이 브라우저의 IndexedDB에 둔다(PRD 데이터 표). 서버에는 남지 않는다.
// 리포트가 끝나면 deletePayload로 지우고, 24시간이 지나면 읽을 때(loadPayload)와 대화 화면을 열 때(sweepPayloads) 지운다.
import { del, entries, get, set } from "idb-keyval";
import type { Payload } from "@/lib/payload/build";

const TTL_MS = 24 * 3_600_000;
const PREFIX = "payload:";
const key = (id: string) => `${PREFIX}${id}`;

interface Stored {
  savedAt: number;
  payload: Payload;
}

/** 배포 전에 저장한 v1 페이로드는 형식이 다른 것으로 본다(다시 올려야 한다) */
const isStored = (v: unknown): v is Stored =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as Stored).savedAt === "number" &&
  typeof (v as Stored).payload === "object" &&
  (v as Stored).payload !== null &&
  (v as Stored).payload.v === 2;
/** 형식이 맞고 저장한 지 24시간이 지나지 않았다 */
const isFresh = (v: unknown): v is Stored => isStored(v) && Date.now() - v.savedAt <= TTL_MS;

export async function savePayload(id: string, p: Payload): Promise<void> {
  await set(key(id), { savedAt: Date.now(), payload: p } satisfies Stored);
}

/** 저장한 지 24시간이 지났거나 형식이 다르면 지우고 null */
export async function loadPayload(id: string): Promise<Payload | null> {
  const stored: unknown = await get(key(id));
  if (stored === undefined) return null;
  if (!isFresh(stored)) {
    await del(key(id));
    return null;
  }
  return stored.payload;
}

export async function deletePayload(id: string): Promise<void> {
  await del(key(id));
}

/** 저장한 지 24시간이 지났거나 형식이 다른 페이로드를 모두 지운다(다시 찾아오지 않은 대화의 것까지) */
export async function sweepPayloads(): Promise<void> {
  for (const [k, v] of await entries()) {
    if (typeof k === "string" && k.startsWith(PREFIX) && !isFresh(v)) await del(k);
  }
}
