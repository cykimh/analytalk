// 표시 이름: 업로더가 정한 이름(기본은 성을 뺀 카톡 이름)을 발신자에만 적용하고, 분석에서 뺀 멤버·봇의 메시지를 거른다.
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
function cleanDisplayName(name: string): string {
  const cleaned = [...name.replace(FORBIDDEN_ALL, "").replace(/\s+/g, " ").trim()].slice(0, NAME_MAX).join("").trim();
  return checkDisplayName(cleaned) === null ? cleaned : name;
}

// 흔한 한국 성(한 글자). 카톡 이름이 '성 + 두 글자'일 때만 성을 뗀다
const SURNAMES = new Set(
  "김이박최정강조윤장임한오서신권황안송류전홍고문양손배백허유남심노하곽성차주우구민진나지엄채원천방공현함변염여추도소석선설마길연위표명기반라왕금옥육인맹제모탁국어은편용예경봉사부가복태목형피두감음빈동온호범좌팽승간상갈",
);
// 두 글자 성. '두 글자 성 + 한 글자'(남궁민·선우진)는 어디까지가 성인지 알 수 없어 그대로 둔다
const TWO_CHAR_SURNAMES = new Set(["서문", "남궁", "제갈", "황보", "선우", "독고"]);

/** 정확히 한글 3글자이고 첫 글자가 흔한 성이면 뒤 두 글자(김민지 → 민지). 다른 모양(영문·2글자·4글자 이상·별명)은 그대로 */
function dropSurname(name: string): string {
  if (!/^[가-힣]{3}$/.test(name) || !SURNAMES.has(name[0]) || TWO_CHAR_SURNAMES.has(name.slice(0, 2))) return name;
  return name.slice(1);
}

/** 기본 표시 이름: 금지 글자를 정리하고(cleanDisplayName) 성을 뺀 이름. 화면의 입력칸에서 바로 고칠 수 있다 */
export function defaultDisplayName(name: string): string {
  return dropSurname(cleanDisplayName(name));
}

/**
 * 발신자마다 기본 표시 이름. 성을 빼서 다른 사람의 이름과 겹치면(김민지·이민지, 김민지·민지) 성을 뺀 쪽을 정리한 전체 이름으로 되돌린다.
 * 정리한 전체 이름끼리 겹치는 것은 그대로 둔다(화면이 막고 이유를 보인다)
 */
export function defaultNames(targets: string[]): NameMap {
  const full = new Map(targets.map((t) => [t, cleanDisplayName(t)]));
  const names = new Map(targets.map((t) => [t, defaultDisplayName(t)]));
  for (let changed = true; changed; ) {
    changed = false;
    const seen = new Map<string, number>();
    for (const v of names.values()) seen.set(v, (seen.get(v) ?? 0) + 1);
    for (const t of targets) {
      if ((seen.get(names.get(t)!) ?? 0) > 1 && names.get(t) !== full.get(t)) {
        names.set(t, full.get(t)!);
        changed = true;
      }
    }
  }
  return Object.fromEntries(names);
}

// 사람이 아닌 발신자: 탈퇴한 사용자, 이름이 봇·bot으로 끝나는 계정, GPT·카카오톡 계정
const UNKNOWN_SENDER = /^\(?알수없음\)?$/;
const BOT_SUFFIX = /(?:봇|bot)$/i;
// ChatGPT·챗GPT는 GPT에, 오픈채팅봇은 채팅봇에 걸린다
const BOT_WORDS = /gpt|채팅봇|카카오톡/i;

/**
 * 봇·알 수 없음이면 true. 이름 목록에 보이지 않고 메시지는 어디에도 싣지 않는다(뺀 멤버와 같은 경로, 다시 켜는 토글 없음).
 * 이름이 우연히 '봇'으로 끝나는 사람(로봇)도 빠진다
 */
export function isBotOrUnknown(name: string): boolean {
  const t = name.trim();
  return UNKNOWN_SENDER.test(t.replace(/\s+/g, "")) || BOT_SUFFIX.test(t) || BOT_WORDS.test(t);
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

/** 발신자만 표시 이름으로 바꾸고 excluded 발신자와 봇·알 수 없음(isBotOrUnknown)의 메시지는 뺀다. text는 그대로. 입력은 바꾸지 않는다 */
export function applyDisplayNames(
  msgs: ChatMessage[],
  o: NameOptions,
): { ok: true; messages: ChatMessage[] } | { ok: false; reason: NameError } {
  const out = new Set(o.excluded ?? []);
  const kept = msgs.filter((m) => m.sender === null || (!out.has(m.sender) && !isBotOrUnknown(m.sender)));
  const targets = [...new Set(kept.flatMap((m) => (m.sender === null ? [] : [m.sender])))].filter((n) => n !== "");
  const reason = checkNameMap(o.map, targets, o.merged);
  if (reason) return { ok: false, reason };
  return {
    ok: true,
    messages: kept.map((m) => (m.sender === null ? { ...m } : { ...m, sender: o.map[m.sender].trim() })),
  };
}
