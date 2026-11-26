// 이 브라우저에서 만든 연재 목록(localStorage `analytalk:recent`). 시작 화면이 /c/[id]로 돌아가는 링크를 그린다.
// 서버에는 대화 목록 API가 없고 초대 코드는 여러 사람이 같이 쓸 수 있어서, 만든 브라우저만 기억한다.
// id·컨셉·말투·만든 시각만 둔다(표시 이름·대화 내용은 넣지 않는다). 저장이 막혀도 화면은 동작한다.
import { RETENTION_DAYS } from "@/lib/config";
import { type Tone, TONE_KEYS } from "@/lib/llm/concepts";

const KEY = "analytalk:recent";
const MAX_ENTRIES = 20;
const TTL_MS = RETENTION_DAYS * 86_400_000;

export interface RecentSeries {
  id: string;
  concept: "group" | "couple";
  /** 말투. v1 항목에는 없다 */
  tone?: Tone;
  /** 만든 시각(ms) */
  createdAt: number;
}

const isEntry = (v: unknown): v is RecentSeries =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as RecentSeries).id === "string" &&
  ((v as RecentSeries).concept === "group" || (v as RecentSeries).concept === "couple") &&
  typeof (v as RecentSeries).createdAt === "number" &&
  ((v as RecentSeries).tone === undefined || (TONE_KEYS as readonly unknown[]).includes((v as RecentSeries).tone));

function read(): RecentSeries[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    return [];
  }
}

function write(entries: RecentSeries[]): void {
  try {
    if (entries.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    // 사생활 보호 모드·저장 차단: 목록을 보여 주지 못할 뿐이다
  }
}

/** 보관 기간(30일) 안의 연재를 최근 것부터 */
export function listSeries(): RecentSeries[] {
  const now = Date.now();
  return read()
    .filter((e) => now - e.createdAt < TTL_MS)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** 만든(또는 같은 요청으로 다시 받은) 연재를 넣는다. 같은 id는 한 번만, 만든 시각 최근 순서로 20개까지 */
export function rememberSeries(entry: RecentSeries): void {
  const all = listSeries();
  const before = all.find((e) => e.id === entry.id);
  // 같은 요청으로 다시 받은 연재(중복 200)는 처음 만든 시각을 지킨다(서버 보관 30일과 맞춘다)
  const createdAt = before ? Math.min(before.createdAt, entry.createdAt) : entry.createdAt;
  const next = [{ id: entry.id, concept: entry.concept, ...(entry.tone ? { tone: entry.tone } : {}), createdAt }, ...all.filter((e) => e.id !== entry.id)];
  write(next.sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_ENTRIES));
}

/** 지웠거나 없어진(404) 연재를 뺀다 */
export function forgetSeries(id: string): void {
  write(listSeries().filter((e) => e.id !== id));
}
