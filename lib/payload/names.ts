// 이름 정리: 원래 발신자 이름을 업로더가 정한 표시 이름으로 바꾸고, 본문 속 이름도 바꾼다.
// 서버·Anthropic·DB가 보는 이름은 모두 여기서 정한 표시 이름이다. DOM 없이 브라우저(Worker)·node 공용.
import type { ChatMessage } from "@/lib/parse/parse";

/** 원래 발신자 → 표시 이름. 별칭 합치기는 여러 키가 같은 값을 갖는다 */
export type NameMap = Record<string, string>;
export type NameError = "empty" | "invalid" | "collision" | "unmapped";

const NAME_MAX = 20;
// 줄 형식(|), 통계 경로(.), 자리표시자({ }), 프롬프트 태그(< >)를 깨는 글자와 줄바꿈
const FORBIDDEN = /[|.{}<>\r\n\u2028\u2029]/;
// 통계 맵(Record<이름, …>)의 키가 되면 Object.prototype 속성과 겹치는 이름(constructor·__proto__·toString 등)
const PROTOTYPE_NAMES = new Set(Object.getOwnPropertyNames(Object.prototype));

// 한글 이름 뒤에 붙어도 이름으로 보는 말(이 말로 시작하면 뒤에 한글이 더 붙어도 된다).
// '수'로 시작하는 말은 넣지 않는다("민지수"는 다른 단어로 본다). 앞 글자가 같은 말(이었→이, 야말로→야, 아빠→아)은 앞 글자로 잡힌다
const PARTICLES = [
  // 계획의 목록
  ...["야", "아", "이", "가", "는", "은", "도", "랑", "한테", "님", "씨"],
  // 흔한 조사
  ...["을", "를", "의", "와", "과", "로", "으로", "에", "께", "하고", "만", "나", "네", "들", "까지", "부터", "처럼", "보다"],
  ...["보고", "더러", "같이", "마저", "조차", "뿐", "밖에", "대로", "만큼", "든"],
  // 서술격·어미 머리: 민지라고·민지인데·민지였어·민지잖아·민지면·민지임·민지요·민지예요·민지래·민지냐·민지니·민지거·민지꺼·민지겠지
  ...["라", "인", "였", "잖", "면", "임", "요", "예", "래", "냐", "니", "거", "꺼", "겠"],
  // 호칭·별명 꼬리
  ...["언니", "오빠", "누나", "형", "선배", "쌤", "짱", "쨩", "양", "군", "엄마", "맘", "공주", "왕자"],
];
// 본문에서 한글 이름 앞에 붙어도 이름으로 보는 말: 우리민지·울민지·내민지·애기민지·내사랑민지.
// 사랑·최고 같은 말은 넣지 않는다("사랑해원래"의 "해원"처럼 다른 말을 이름으로 바꾼다)
const PREFIXES = ["우리", "울", "내", "애기", "아기", "내사랑"];

// 별명형 이름의 꼬리. "민지공주"·"민지짱"·"김민지님"·"하은사랑"은 꼬리를 뗀 "민지"·"김민지"·"하은"도 이름으로 본다.
// 이·아·야는 넣지 않는다("박수아"의 "아"는 이름의 일부다)
const NICK_SUFFIXES = [
  ...["공주", "왕자", "언니", "오빠", "누나", "엄마", "아빠", "이모", "삼촌", "선배", "님", "씨", "짱", "쨩", "맘", "쌤"],
  ...["사랑", "바보", "최고", "천사", "돼지", "토끼", "폰"],
];
// 별명형 이름의 머리말. "우리민지"·"애기김민지"·"울애기민지"는 머리말을 뗀 "민지"·"김민지"도 이름으로 본다
const NICK_PREFIXES = [...PREFIXES, "사랑", "이쁜", "예쁜", "귀요미", "최고", "나의"];
// 긴 말부터 뗀다(내사랑 → 내)
const SUFFIXES_DESC = [...NICK_SUFFIXES].sort((a, b) => b.length - a.length);
const PREFIXES_DESC = [...NICK_PREFIXES].sort((a, b) => b.length - a.length);
// 흔한 1글자 성(인구 상위 약 40개). 이 성으로 시작하는 이름은 앞 2글자("정도"윤·"고민"지·"나도"윤)를 이름으로 보지 않는다.
// 민·지처럼 별명 첫 글자로 흔한 성은 넣지 않는다("민지짱"의 "민지")
const COMMON_SURNAMES = new Set([..."김이박최정강조윤장임한오서신권황안송전홍유류고문양손배백허남노심하곽성차주우구나"]);
const TWO_CHAR_SURNAMES = new Set(["남궁", "제갈", "선우", "독고", "황보", "사공", "서문", "동방"]);
// 이름 조각이나 짧은 이름이 되면 본문의 흔한 말까지 바뀌는 말(호칭·관계·직함). 전체 이름이면 그래도 바꾼다
const STOP_PIECES = new Set([
  ...NICK_SUFFIXES,
  ...NICK_PREFIXES,
  ...["자기", "자기야", "여보", "아가", "형님", "오라버니", "동생", "친구", "가족", "본인"],
  ...["남편", "아내", "와이프", "회사", "팀장", "과장", "대리", "부장", "사장", "실장", "차장", "선생", "선생님", "교수", "교수님"],
  // "회사동료"처럼 4글자 덩어리의 끝 2글자가 되는 관계 말. 실제 이름일 수 있는 말(동기 등)은 넣지 않는다
  ...["후배", "동료", "상사", "고모", "사촌", "조카"],
]);

const HANGUL_RUN = /^[가-힣]+$/;
// 이름을 조각으로 나눈다: 한글 음절 덩어리, 또는 한글이 아닌 글자·숫자 덩어리(ㅋ 같은 낱자는 버린다)
const PIECE = /[가-힣]+|(?:(?!\p{Script=Hangul})[\p{L}\p{N}])+/gu;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fold = (s: string) => s.toLowerCase();
const byLengthDesc = (a: string, b: string) => [...b].length - [...a].length;

/** 표시 이름 하나의 문제. 앞뒤 공백을 뗀 1~20자(코드 포인트)이고 금지 문자가 없고 Object.prototype 속성 이름이 아니면 null */
export function checkDisplayName(name: string): "empty" | "invalid" | null {
  const t = name.trim();
  if (t === "") return "empty";
  if ([...t].length > NAME_MAX || FORBIDDEN.test(t) || PROTOTYPE_NAMES.has(t)) return "invalid";
  return null;
}

/** 별명 꼬리. 뗀 뒤 2글자 이상 남을 때만 */
const nickSuffix = (w: string) => SUFFIXES_DESC.find((s) => w.endsWith(s) && w.length - s.length >= 2);
/** 별명 머리말. 뗀 뒤 2글자 이상 남을 때만 */
const nickPrefix = (w: string) => PREFIXES_DESC.find((p) => w.startsWith(p) && w.length - p.length >= 2);

/**
 * 짧은 이름(2글자) 후보. 3글자 이상 한글 덩어리에만
 * - 2자 성이면 3~4번째 글자, 아니면 2~3번째 글자. 흔한 성으로 시작하지 않으면 별명일 수 있어 앞 2글자도 본다("민지짱"·"민지최고")
 * - 4글자 이상이면 끝 2글자도 본다. 앞에 별명이 붙은 이름("우리민지"·"이쁜민지"·"최고민지")은 실제 이름이 끝에 온다.
 *   별명 꼬리로 끝나면 끝 2글자에 꼬리가 섞이므로("김민지맘"의 "지맘") 보지 않는다(꼬리를 뗀 말이 따로 후보가 된다)
 */
function shortForms(w: string): string[] {
  if (w.length < 3) return [];
  const out: string[] = [];
  if (w.length >= 4 && TWO_CHAR_SURNAMES.has(w.slice(0, 2))) out.push(w.slice(2, 4));
  else {
    out.push(w.slice(1, 3));
    if (!COMMON_SURNAMES.has(w[0])) out.push(w.slice(0, 2));
  }
  if (w.length >= 4 && !nickSuffix(w)) out.push(w.slice(-2));
  return out;
}

/**
 * 한글 덩어리와, 별명 꼬리·머리말을 거듭 떼어 나온 말들(덩어리가 맨 앞).
 * 예: "애기김민지공주" → 애기김민지공주, 애기김민지, 김민지공주, 김민지
 */
function nickBases(piece: string): string[] {
  const out = [piece];
  for (let i = 0; i < out.length; i++) {
    const w = out[i];
    const tail = nickSuffix(w);
    const head = nickPrefix(w);
    for (const next of [tail && w.slice(0, -tail.length), head && w.slice(head.length)]) {
      if (next && !out.includes(next)) out.push(next);
    }
  }
  return out;
}

/**
 * 원래 이름 하나에서 본문에서 찾을 말들. 전체 이름이 맨 앞이다.
 * - 한글 덩어리: 덩어리 자체, 별명 꼬리·머리말을 뗀 말, 그 말들의 짧은 이름(shortForms)
 * - 한글이 아닌 덩어리("Minji Kim"의 Minji·Kim): 2글자 이상이고 글자가 들어 있으면
 * - 조각·짧은 이름이 STOP_PIECES이면 뺀다
 */
function nameKeys(name: string): string[] {
  const keys = new Set<string>();
  const add = (k: string) => {
    if (k.length >= 2 && !STOP_PIECES.has(k)) keys.add(k);
  };
  for (const piece of name.match(PIECE) ?? []) {
    if (HANGUL_RUN.test(piece)) {
      for (const base of nickBases(piece)) {
        if (STOP_PIECES.has(base)) continue;
        add(base);
        shortForms(base).forEach(add);
      }
    } else if ([...piece].length >= 2 && /\p{L}/u.test(piece)) add(piece);
  }
  keys.delete(name);
  return [name, ...keys];
}

// 찾은 말의 앞뒤 경계. 말의 첫·끝 글자 종류에 따라 다르다
type Edge = "syllable" | "jamo" | "word" | "other";
function edgeOf(ch: string): Edge {
  if (/[가-힣]/.test(ch)) return "syllable";
  if (/\p{Script=Hangul}/u.test(ch)) return "jamo";
  if (/[\p{L}\p{N}]/u.test(ch)) return "word";
  return "other";
}
const BEFORE: Record<Edge, string> = {
  // 앞이 한글 음절이면 다른 단어. 우리·울·내는 예외
  syllable: `(?:(?<![가-힣])|(?<=${PREFIXES.join("|")}))`,
  // 라틴 문자 등: 앞이 글자·숫자면 다른 단어. 한글은 붙어 써도 된다("ㅋㅋMinji")
  word: String.raw`(?:(?<![\p{L}\p{N}])|(?<=\p{Script=Hangul}))`,
  // ㅋ 같은 낱자 이름: 앞뒤에 글자가 붙으면 다른 말("ㅋㅋㅋ")
  jamo: String.raw`(?<![\p{L}\p{N}])`,
  other: "",
};
const AFTER: Record<Edge, string> = {
  // 뒤가 한글 음절이면 다른 단어. 조사·어미·호칭(PARTICLES)으로 시작하면 이름
  syllable: `(?=${PARTICLES.join("|")}|(?![가-힣]))`,
  word: String.raw`(?:(?![\p{L}\p{N}])|(?=\p{Script=Hangul}))`,
  jamo: String.raw`(?![\p{L}\p{N}])`,
  other: "",
};

/** 긴 말부터 찾는 정규식. 경계 종류가 같은 이웃끼리 묶어 alternation을 줄인다(같은 위치에서는 늘 긴 말이 먼저다) */
function namePattern(keys: string[]): RegExp | null {
  if (keys.length === 0) return null;
  const sorted = [...keys].sort(byLengthDesc);
  const chunks: { before: string; after: string; keys: string[] }[] = [];
  for (const k of sorted) {
    const cps = [...k];
    const before = BEFORE[edgeOf(cps[0])];
    const after = AFTER[edgeOf(cps[cps.length - 1])];
    const last = chunks.at(-1);
    if (last && last.before === before && last.after === after) last.keys.push(k);
    else chunks.push({ before, after, keys: [k] });
  }
  return new RegExp(chunks.map((c) => `${c.before}(?:${c.keys.map(escapeRe).join("|")})${c.after}`).join("|"), "giu");
}

/** 대소문자를 무시하고 찾은 말의 원래 키. 보통은 소문자로 바로 찾고, 특수한 대소문자 접기만 하나씩 비교한다 */
function lookup<T>(table: Map<string, T>, hit: string): T | undefined {
  const direct = table.get(fold(hit));
  if (direct !== undefined) return direct;
  for (const [k, v] of table) if (new RegExp(`^${escapeRe(k)}$`, "iu").test(hit)) return v;
  return undefined;
}

/**
 * 발신자와 본문 속 이름을 표시 이름으로 바꾼 새 메시지 배열을 돌려준다(입력은 바꾸지 않는다).
 * - map은 모든 발신자와 systemNames(초대·나감 알림 속 이름)를 덮어야 한다. 하나라도 없으면 unmapped
 * - 서로 다른 원래 이름 둘이 같은 표시 이름이면 collision. 예외는 merged의 같은 그룹([같은 사람])뿐이다
 * - 본문 치환 대상(nameKeys): 전체 이름, 이름 조각, 별명 꼬리·머리말을 뗀 말, 3글자 이상 한글이면 성을 뺀 2글자,
 *   4글자 이상 한글이면 끝 2글자. 긴 말부터 한 번에 바꾸고, 한글이 아닌 말은 대소문자를 무시한다
 * - 한글 말은 앞뒤가 한글 음절이면 다른 단어로 보고 둔다. 다만 뒤에 조사·어미·호칭(PARTICLES)이 붙거나
 *   앞에 우리·울·내·애기·아기·내사랑(PREFIXES)이 붙으면 바꾼다. 그래도 남는 조각은 findNameLeftovers로 확인 화면에 보여 준다
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

  // 전체 이름을 먼저 넣어서, 조각·짧은 이름이 다른 사람의 전체 이름과 같으면 전체 이름 쪽이 이긴다
  const replace = new Map<string, string>();
  const keysOf = new Map(targets.map((t) => [t, nameKeys(t)]));
  for (const t of targets) if (!replace.has(fold(t))) replace.set(fold(t), display.get(t)!);
  for (const t of targets) {
    for (const k of keysOf.get(t)!.slice(1)) if (!replace.has(fold(k))) replace.set(fold(k), display.get(t)!);
  }

  const re = namePattern([...new Set([...keysOf.values()].flat())]);
  const rename = (text: string) => (re ? text.replace(re, (hit) => lookup(replace, hit) ?? hit) : text);

  return {
    ok: true,
    messages: msgs.map((m) => ({ ...m, sender: m.sender === null ? null : display.get(m.sender)!, text: rename(m.text) })),
  };
}

/** 바꾼 뒤에도 본문에 남은 원래 이름 조각 하나. ids는 그 조각이 든 메시지 id(처음 나온 순서) */
export interface NameLeftover {
  piece: string;
  count: number;
  ids: number[];
}

/**
 * applyDisplayNames를 거친 메시지에서, 경계 규칙 때문에 바뀌지 않고 남은 원래 이름 조각(2글자 이상)을 찾는다.
 * 예: {김민지:"P1"}일 때 "민지수"의 "민지". 이름 정리 확인 화면에서 업로더에게 보여 주려는 것이다.
 * 결과에 실제 이름이 들어 있으므로 브라우저 밖으로 보내지 않는다.
 * - 대상: map의 모든 원래 이름에서 나온 말(nameKeys). 대소문자를 무시하고 단어 경계 없이 찾는다
 * - 표시 이름 안에 들어 있는 말은 업로더가 고른 것이라 세지 않는다
 * - 사람이 보낸 text 메시지만 본다(시스템·미디어 메시지는 페이로드에 본문이 실리지 않는다)
 * - 많이 남은 순서로 돌려준다
 */
export function findNameLeftovers(msgs: ChatMessage[], map: NameMap): NameLeftover[] {
  const shown = Object.values(map).map((v) => fold(v.trim()));
  const pieces = new Map<string, string>();
  for (const name of Object.keys(map)) {
    for (const k of nameKeys(name)) {
      const f = fold(k);
      if ([...k].length < 2 || pieces.has(f) || shown.some((s) => s.includes(f))) continue;
      pieces.set(f, k);
    }
  }
  if (pieces.size === 0) return [];

  const re = new RegExp([...pieces.keys()].sort(byLengthDesc).map(escapeRe).join("|"), "giu");
  const found = new Map<string, NameLeftover>();
  for (const m of msgs) {
    if (m.sender === null || m.kind !== "text") continue;
    for (const [hit] of m.text.matchAll(re)) {
      const piece = lookup(pieces, hit) ?? hit;
      let f = found.get(piece);
      if (!f) found.set(piece, (f = { piece, count: 0, ids: [] }));
      f.count++;
      if (f.ids.at(-1) !== m.id) f.ids.push(m.id);
    }
  }
  return [...found.values()].sort((a, b) => b.count - a.count || (a.piece < b.piece ? -1 : 1));
}
