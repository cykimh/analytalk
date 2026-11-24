// 스트리밍 중이거나 끊긴 JSON 출력에서 완결된 값만 꺼낸다. 서버 전용.
// 스키마 속성 순서(safety → … → reading_notes → … → sections → next_teaser)를 그대로 따라 생성되므로
// 맨 위 객체를 앞에서부터 훑으며, 닫는 글자까지 온 값만 완결로 본다. 끝나지 않은 배열은 완결된 원소만 쓴다.
import "server-only";
import { NOTE_MAX_CHARS } from "@/lib/config";
import { isBanned } from "@/lib/payload/banned";
import type { Episode } from "./schema";

type Note = { range: string; note: string };
/** 값 하나의 자리. end는 값 다음 글자 인덱스이고, 글이 값 중간에서 끝났으면 null */
type Slot = { start: number; end: number | null };

const isWs = (c: string | undefined) => c === " " || c === "\n" || c === "\r" || c === "\t";
const skipWs = (s: string, i: number) => {
  while (isWs(s[i])) i++;
  return i;
};

/** s[i]의 `"`에서 시작한 문자열이 끝나는 위치(닫는 따옴표 다음). 끝나지 않았으면 null */
function stringEnd(s: string, i: number): number | null {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === "\\") j++;
    else if (s[j] === '"') return j + 1;
  }
  return null;
}

/** s[i]에서 시작한 값 하나가 끝나는 위치. 숫자·true·false·null은 뒤에 구분 글자가 와야 끝난 것으로 본다 */
function valueEnd(s: string, i: number): number | null {
  const c = s[i];
  if (c === '"') return stringEnd(s, i);
  if (c === "{" || c === "[") {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (ch === '"') {
        const e = stringEnd(s, j);
        if (e === null) return null;
        j = e - 1;
      } else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) return j + 1;
      }
    }
    return null;
  }
  let j = i;
  while (j < s.length && /[\w.+-]/.test(s[j])) j++;
  return j > i && j < s.length ? j : null;
}

/** s[i]의 `{`에서 시작한 객체의 멤버를 앞에서부터. 끝나지 않은 멤버가 나오면 그것까지 내고 멈춘다 */
function* members(s: string, i: number): Generator<{ key: string; slot: Slot }> {
  i = skipWs(s, i + 1);
  while (i < s.length && s[i] !== "}") {
    if (s[i] === ",") {
      i = skipWs(s, i + 1);
      continue;
    }
    const keyEnd = s[i] === '"' ? stringEnd(s, i) : null;
    if (keyEnd === null) return;
    const key = parseJson(s.slice(i, keyEnd));
    i = skipWs(s, keyEnd);
    if (typeof key !== "string" || s[i] !== ":") return;
    const start = skipWs(s, i + 1);
    if (start >= s.length) return;
    const end = valueEnd(s, start);
    yield { key, slot: { start, end } };
    if (end === null) return;
    i = skipWs(s, end);
  }
}

/** s[i]의 `[`에서 시작한 배열의 완결된 원소들(JSON으로 읽은 값) */
function completeElements(s: string, i: number): unknown[] {
  const out: unknown[] = [];
  i = skipWs(s, i + 1);
  while (i < s.length && s[i] !== "]") {
    if (s[i] === ",") {
      i = skipWs(s, i + 1);
      continue;
    }
    const end = valueEnd(s, i);
    if (end === null) break;
    const v = parseJson(s.slice(i, end));
    if (v !== undefined) out.push(v);
    i = skipWs(s, end);
  }
  return out;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 완결된 값은 그대로, 끝나지 않은 배열은 완결된 원소만, 그 밖의 끝나지 않은 값은 undefined */
function readSlot(s: string, slot: Slot): unknown {
  if (slot.end !== null) return parseJson(s.slice(slot.start, slot.end));
  return s[slot.start] === "[" ? completeElements(s, slot.start) : undefined;
}

const topObject = (s: string): number | null => {
  const i = skipWs(s, 0);
  return s[i] === "{" ? i : null;
};

const isNote = (v: unknown): v is Note =>
  typeof v === "object" && v !== null && typeof (v as Note).range === "string" && typeof (v as Note).note === "string";

/** 스트리밍 중인 출력에서 reading_notes의 완결된 메모들 */
export function extractReadingNotes(partialJson: string): Note[] {
  const top = topObject(partialJson);
  if (top === null) return [];
  for (const { key, slot } of members(partialJson, top)) {
    if (key !== "reading_notes") continue;
    const v = readSlot(partialJson, slot);
    return Array.isArray(v) ? v.filter(isNote) : [];
  }
  return [];
}

/** 화면·DB에 내보낼 메모만 남긴다: 모양 확인, 앞뒤 공백 제거, 금지 표현이 든 메모 제거, 메모를 60자(코드 포인트)로 자르기 */
export function sanitizeNotes(notes: unknown): Note[] {
  if (!Array.isArray(notes)) return [];
  return notes.flatMap((n) => {
    if (!isNote(n)) return [];
    const range = n.range.trim();
    const note = n.note.trim();
    if (note === "" || isBanned(range) || isBanned(note)) return [];
    return [{ range, note: Array.from(note).slice(0, NOTE_MAX_CHARS).join("") }];
  });
}

/**
 * 끊긴 출력에서 완결된 필드를 살린다. sections는 완결된 섹션(그 안의 근거 포함)까지다.
 * safety가 완결되지 않았으면 null이다. 값의 모양은 확인하지 않는다(validateEpisode가 한다)
 */
export function salvageEpisode(partialJson: string): Partial<Episode> | null {
  const top = topObject(partialJson);
  if (top === null) return null;
  const out: Record<string, unknown> = {};
  for (const { key, slot } of members(partialJson, top)) {
    const v = readSlot(partialJson, slot);
    if (v !== undefined) out[key] = v;
  }
  const safety = out.safety;
  if (typeof safety !== "object" || safety === null || Array.isArray(safety)) return null;
  return out as Partial<Episode>;
}
