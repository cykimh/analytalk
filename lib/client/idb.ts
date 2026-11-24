// 재시도용 페이로드를 이 브라우저의 IndexedDB에 둔다(PRD 데이터 표). 서버에는 남지 않는다.
// 4편이 모두 끝나면 deletePayload로 지우고(Task 13), 24시간이 지나면 읽을 때 지운다.
import { del, get, set } from "idb-keyval";
import type { Payload } from "@/lib/payload/build";

const TTL_MS = 24 * 3_600_000;
const key = (id: string) => `payload:${id}`;

interface Stored {
  savedAt: number;
  payload: Payload;
}

const isStored = (v: unknown): v is Stored =>
  typeof v === "object" && v !== null && typeof (v as Stored).savedAt === "number" && typeof (v as Stored).payload === "object";

export async function savePayload(id: string, p: Payload): Promise<void> {
  await set(key(id), { savedAt: Date.now(), payload: p } satisfies Stored);
}

/** 저장한 지 24시간이 지났거나 형식이 다르면 지우고 null */
export async function loadPayload(id: string): Promise<Payload | null> {
  const stored: unknown = await get(key(id));
  if (stored === undefined) return null;
  if (!isStored(stored) || Date.now() - stored.savedAt > TTL_MS) {
    await del(key(id));
    return null;
  }
  return stored.payload;
}

export async function deletePayload(id: string): Promise<void> {
  await del(key(id));
}
