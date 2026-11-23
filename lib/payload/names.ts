// 이름 정리: 원래 발신자 이름을 업로더가 정한 표시 이름으로 바꾸고, 본문 속 이름도 바꾼다.
// 서버·Anthropic·DB가 보는 이름은 모두 여기서 정한 표시 이름이다. DOM 없이 브라우저(Worker)·node 공용.
import type { ChatMessage } from "@/lib/parse/parse";

/** 원래 발신자 → 표시 이름. 별칭 합치기는 여러 키가 같은 값을 갖는다 */
export type NameMap = Record<string, string>;
export type NameError = "empty" | "invalid" | "collision" | "unmapped";

const NAME_MAX = 20;
// 줄 형식(|), 통계 경로(.), 자리표시자({ }), 프롬프트 태그(< >)를 깨는 글자와 줄바꿈
const FORBIDDEN = /[|.{}<>\r\n\u2028\u2029]/;

// 이름 뒤에 붙어도 이름으로 보는 말(이 말로 시작하면 뒤에 한글이 더 붙어도 된다).
// 앞의 11개(야·아·이·가·는·은·도·랑·한테·님·씨)가 계획의 목록이고, 나머지는 "김민지를"·"민지에게"·"민지언니"처럼
// 실제 이름이 새지 않도록 더한 흔한 조사·호칭이다. '수'로 시작하는 말은 넣지 않는다("민지수"는 다른 단어로 본다)
const PARTICLES = [
  ...["야", "아", "이", "가", "는", "은", "도", "랑", "한테", "님", "씨"],
  ...["을", "를", "의", "와", "과", "로", "으로", "에", "께", "하고", "만", "나", "네", "들", "까지", "부터", "처럼", "보다"],
  ...["언니", "오빠", "누나", "형", "선배", "쌤"],
];
const HANGUL_NAME = /^[가-힣]{3,}$/;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 표시 이름 하나의 문제. 앞뒤 공백을 뗀 1~20자(코드 포인트)이고 금지 문자가 없으면 null */
export function checkDisplayName(name: string): "empty" | "invalid" | null {
  const t = name.trim();
  if (t === "") return "empty";
  if ([...t].length > NAME_MAX || FORBIDDEN.test(t)) return "invalid";
  return null;
}

/**
 * 발신자와 본문 속 이름을 표시 이름으로 바꾼 새 메시지 배열을 돌려준다(입력은 바꾸지 않는다).
 * - map은 모든 발신자와 systemNames(초대·나감 알림 속 이름)를 덮어야 한다. 하나라도 없으면 unmapped
 * - 서로 다른 원래 이름 둘이 같은 표시 이름이면 collision. 예외는 merged의 같은 그룹([같은 사람])뿐이다
 * - 본문 치환 대상: 전체 이름, 3글자 이상 한글 이름이면 성을 뺀 뒤 2글자. 긴 말부터 한 번에 바꾼다.
 *   앞뒤가 한글 음절이면 다른 단어로 보고 두되, 뒤에 조사·호칭(PARTICLES)이 붙은 경우는 바꾼다
 */
export function applyDisplayNames(
  msgs: ChatMessage[],
  map: NameMap,
  systemNames: string[],
  merged: string[][] = [],
): { ok: true; messages: ChatMessage[] } | { ok: false; reason: NameError } {
  const targets = [...new Set([...msgs.flatMap((m) => (m.sender === null ? [] : [m.sender])), ...systemNames])].filter(
    (n) => n !== "",
  );
  if (targets.some((t) => !Object.prototype.hasOwnProperty.call(map, t))) return { ok: false, reason: "unmapped" };

  const display = new Map<string, string>();
  for (const t of targets) {
    const error = checkDisplayName(map[t]);
    if (error) return { ok: false, reason: error };
    display.set(t, map[t].trim());
  }

  const group = new Map<string, number>();
  merged.forEach((names, i) => names.forEach((n) => group.set(n, i)));
  const owner = new Map<string, string>();
  for (const t of targets) {
    const name = display.get(t)!;
    const first = owner.get(name);
    if (first === undefined) owner.set(name, t);
    else if (group.get(first) === undefined || group.get(first) !== group.get(t)) return { ok: false, reason: "collision" };
  }

  // 전체 이름을 먼저 넣어서, 짧은 이름이 다른 사람의 전체 이름과 같으면 전체 이름 쪽이 이긴다
  const replace = new Map<string, string>();
  for (const t of targets) replace.set(t, display.get(t)!);
  for (const t of targets) if (HANGUL_NAME.test(t) && !replace.has(t.slice(-2))) replace.set(t.slice(-2), display.get(t)!);

  const keys = [...replace.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
  const re =
    keys.length === 0
      ? null
      : new RegExp(`(?<![가-힣])(?:${keys.join("|")})(?=(?:${PARTICLES.join("|")})|(?![가-힣]))`, "g");
  const rename = (text: string) => (re ? text.replace(re, (hit) => replace.get(hit)!) : text);

  return {
    ok: true,
    messages: msgs.map((m) => ({ ...m, sender: m.sender === null ? null : display.get(m.sender)!, text: rename(m.text) })),
  };
}
