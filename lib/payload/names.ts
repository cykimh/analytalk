// 표시 이름: 업로더가 정한 이름(기본은 카톡 이름)을 발신자에만 적용하고, 분석에서 뺀 멤버의 메시지를 거른다.
// 본문은 고치지 않는다(이름 치환 없음). DOM 없이 브라우저(Worker)·node 공용.
import type { ChatMessage } from "@/lib/parse/parse";
import { hasPII } from "./mask";

/** 원래 발신자 → 표시 이름. 별칭 합치기는 여러 키가 같은 값을 갖는다 */
export type NameMap = Record<string, string>;
export type NameError = "empty" | "invalid" | "collision" | "unmapped";

const NAME_MAX = 20;
// 줄 형식(|), 통계 경로(.), 자리표시자({ }), 프롬프트 태그(< >)를 깨는 글자와 줄바꿈
const FORBIDDEN_CHARS = "|.{}<>\\r\\n\\u2028\\u2029";
const FORBIDDEN = new RegExp(`[${FORBIDDEN_CHARS}]`);
const FORBIDDEN_ALL = new RegExp(`[${FORBIDDEN_CHARS}]`, "g");
// 통계 맵(Record<이름, …>)의 키가 되면 Object.prototype 속성과 겹치는 이름(constructor·__proto__·toString 등)
const PROTOTYPE_NAMES = new Set(Object.getOwnPropertyNames(Object.prototype));

/** 표시 이름 하나의 문제. 앞뒤 공백을 뗀 1~20자(코드 포인트)이고 금지 문자·Object.prototype 속성 이름·전화번호 같은 개인정보가 없으면 null */
export function checkDisplayName(name: string): "empty" | "invalid" | null {
  const t = name.trim();
  if (t === "") return "empty";
  if ([...t].length > NAME_MAX || FORBIDDEN.test(t) || PROTOTYPE_NAMES.has(t) || hasPII(t)) return "invalid";
  return null;
}

/** 금지 글자를 빼고 공백을 하나로, 앞뒤를 떼고 20자(코드 포인트)로 자른다. 그래도 못 넘으면 원래 이름 그대로 */
export function defaultDisplayName(name: string): string {
  const cleaned = [...name.replace(FORBIDDEN_ALL, "").replace(/\s+/g, " ").trim()].slice(0, NAME_MAX).join("").trim();
  return checkDisplayName(cleaned) === null ? cleaned : name;
}

/**
 * targets(분석에 넣는 원래 이름)의 표시 이름을 검사한다. 비어 있거나 못 쓰는 이름 → empty·invalid, map에 없으면 unmapped,
 * 서로 다른 두 사람이 같은 이름이면 collision(같은 merged 묶음은 예외)
 */
export function checkNameMap(map: NameMap, targets: string[], merged: string[][] = []): NameError | null {
  if (targets.some((t) => !Object.prototype.hasOwnProperty.call(map, t))) return "unmapped";
  const group = new Map<string, number>();
  merged.forEach((names, i) => names.forEach((n) => group.set(n, i)));
  const owner = new Map<string, string>();
  for (const t of targets) {
    const error = checkDisplayName(map[t]);
    if (error) return error;
    const name = map[t].trim();
    const first = owner.get(name);
    if (first === undefined) owner.set(name, t);
    else if (group.get(first) === undefined || group.get(first) !== group.get(t)) return "collision";
  }
  return null;
}

export interface NameOptions {
  map: NameMap;
  /** [같은 사람]으로 합친 원래 이름 묶음 */
  merged?: string[][];
  /** 분석에서 뺄 원래 이름(합친 사람 포함) */
  excluded?: readonly string[];
}

/** 발신자만 표시 이름으로 바꾸고 excluded 발신자의 메시지는 뺀다. text는 그대로. 입력은 바꾸지 않는다 */
export function applyDisplayNames(
  msgs: ChatMessage[],
  o: NameOptions,
): { ok: true; messages: ChatMessage[] } | { ok: false; reason: NameError } {
  const out = new Set(o.excluded ?? []);
  const kept = msgs.filter((m) => m.sender === null || !out.has(m.sender));
  const targets = [...new Set(kept.flatMap((m) => (m.sender === null ? [] : [m.sender])))].filter((n) => n !== "");
  const reason = checkNameMap(o.map, targets, o.merged);
  if (reason) return { ok: false, reason };
  return {
    ok: true,
    messages: kept.map((m) => (m.sender === null ? { ...m } : { ...m, sender: o.map[m.sender].trim() })),
  };
}
