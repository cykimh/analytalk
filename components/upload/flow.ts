// 업로드 흐름의 순수 로직(화면 상태 → 이름 맵·확인 문구). DOM 없이 테스트한다.
import { ANCHOR_FIRST_N } from "@/lib/config";
import { legendText, memberCodes, type Payload, readBlock } from "@/lib/payload/build";
import { checkNameMap, defaultDisplayName, type NameError, type NameMap } from "@/lib/payload/names";
import type { ChatMessage, ParseResult } from "@/lib/parse/parse";

export type Kind = Payload["kind"];

export const KIND_LABEL: Record<Kind, string> = { pair: "1:1", group: "친구·가족 단톡", work: "직장·팀" };

/** 방 종류 기본값: 발신자가 2명 이하면 1:1, 그 밖은 단톡 */
export const defaultKind = (participants: number): Kind => (participants <= 2 ? "pair" : "group");

/** 컨셉은 kind에 맞는 것만 쓴다. 직장·팀은 AI가 꺼져 있고(M3) 통계용 페이로드만 group으로 만든다 */
export const conceptFor = (kind: Kind): Payload["concept"] => (kind === "pair" ? "couple" : "group");

/** 줄 인식률(%) 정수. 내려서 98% 미만이 98%로 보이지 않게 한다 */
export const recognitionPercent = (ratio: number) => Math.floor(ratio * 100 + 1e-9);

/** 이름을 정할 원래 이름: 발신자(처음 나온 순서) */
export function nameTargets(parse: Pick<ParseResult, "participants">): string[] {
  return parse.participants.filter((n) => n !== "");
}

export interface NameState {
  /** 원래 이름 → 입력한 표시 이름. 합쳐진 사람은 대표의 값을 쓴다 */
  names: Record<string, string>;
  /** [같은 사람]: 원래 이름 → 대표 원래 이름. 대표는 키가 아니다 */
  sameAs: Record<string, string>;
  /** 분석에서 뺀 대표(원래 이름). 대표에게 합친 사람도 함께 빠진다 */
  excluded: string[];
}

/** 기본 표시 이름은 카톡 이름(금지 글자만 정리) */
export function initialNames(targets: string[]): NameState {
  return { names: Object.fromEntries(targets.map((t) => [t, defaultDisplayName(t)])), sameAs: {}, excluded: [] };
}

/** 대표만 뺄 수 있다(합친 사람은 대표를 따른다). 이미 뺐으면 다시 넣는다 */
export function toggleExcluded(state: NameState, who: string): NameState {
  if (state.sameAs[who] !== undefined) return state;
  const excluded = state.excluded.includes(who) ? state.excluded.filter((x) => x !== who) : [...state.excluded, who];
  return { ...state, excluded };
}

/** who(와 who에 합쳐 둔 사람들)를 into에 합친다 */
export function mergeInto(sameAs: Record<string, string>, who: string, into: string): Record<string, string> {
  const root = sameAs[into] ?? into;
  if (root === who) return sameAs;
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(sameAs)) next[k] = v === who ? root : v;
  next[who] = root;
  return next;
}

export function unmerge(sameAs: Record<string, string>, who: string): Record<string, string> {
  const { [who]: _, ...rest } = sameAs;
  return rest;
}

const rootOf = (sameAs: Record<string, string>, who: string) => sameAs[who] ?? who;

/** 원래 이름 → 표시 이름(앞뒤 공백을 뗀 값. applyDisplayNames가 쓰는 이름과 같다) */
export function nameMapOf(state: NameState, targets: string[]): NameMap {
  return Object.fromEntries(targets.map((t) => [t, (state.names[rootOf(state.sameAs, t)] ?? "").trim()]));
}

/** [대표, 합친 사람…] 묶음(합친 순서) */
export function mergedGroups(sameAs: Record<string, string>): string[][] {
  const groups = new Map<string, string[]>();
  for (const [who, root] of Object.entries(sameAs)) {
    if (!groups.has(root)) groups.set(root, [root]);
    groups.get(root)!.push(who);
  }
  return [...groups.values()];
}

/** 분석에서 뺀 원래 이름(대표에게 합친 사람 포함) */
export function excludedNames(state: NameState, targets: string[]): string[] {
  return targets.filter((t) => state.excluded.includes(rootOf(state.sameAs, t)));
}

/** 분석에 넣는 대표(합쳐지지 않은 사람 중 뺀 사람을 제외) */
export function includedRoots(state: NameState, targets: string[]): string[] {
  return targets.filter((t) => state.sameAs[t] === undefined && !state.excluded.includes(t));
}

export type NameProblem = NameError | "too_few";

/** 지금 이름으로 [다음]을 막을 이유. 넣은 사람만 검사하고, 넣은 대표가 2명 미만이면 too_few */
export function nameProblem(state: NameState, targets: string[]): NameProblem | null {
  if (includedRoots(state, targets).length < 2) return "too_few";
  const out = new Set(excludedNames(state, targets));
  return checkNameMap(nameMapOf(state, targets), targets.filter((t) => !out.has(t)), mergedGroups(state.sameAs));
}

export const NAME_PROBLEM_TEXT: Record<NameProblem, string> = {
  empty: "비어 있는 이름이 있어요. 분석에 넣는 모든 사람에게 표시 이름을 정해 주세요.",
  invalid: "이름은 20자까지, | . { } < > 와 줄바꿈 같은 쓸 수 없는 글자 없이 정해 주세요. 전화번호·계좌 같은 숫자는 이름에 쓸 수 없어요.",
  collision: "두 사람에게 같은 이름을 줄 수 없어요. 같은 사람이면 [같은 사람]으로 합쳐 주세요.",
  unmapped: "이름을 정하지 않은 사람이 있어요.",
  too_few: "분석할 사람이 2명 이상 남아야 AI 리포트를 만들 수 있어요.",
};

export interface SendSummary {
  /** 첫·마지막 메시지의 KST 날짜 `시작 ~ 끝` */
  period: string;
  /** 넣은 멤버의 전체 메시지 수 */
  total: number;
  /** transcript 첫 메시지의 KST 날짜 */
  since: string;
  sent: number;
  /** anchors 중 첫 대화(시스템 메시지를 뺀 처음 ANCHOR_FIRST_N개)와 가장 활발했던 날 메시지 수 */
  first: number;
  busy: number;
  masked: number;
  /** 뺀 멤버(카톡 이름과 메시지 수). 화면에만 있고 페이로드에는 없다 */
  excluded: { name: string; count: number }[];
  legend: { code: string; name: string }[];
  /** 범례 줄들 다음에 transcript 앞 20줄 */
  preview: string[];
}

/** 보낼 내용 확인 화면의 숫자. messages는 페이로드를 만든 메시지(이름 정리 뒤) */
export function sendSummary(p: Payload, messages: ChatMessage[], excluded: { name: string; count: number }[]): SendSummary {
  const firstIds = new Set(
    messages
      .filter((m) => m.sender !== null && m.kind !== "system")
      .map((m) => m.id)
      .sort((a, b) => a - b)
      .slice(0, ANCHOR_FIRST_N),
  );
  let first = 0;
  let busy = 0;
  for (const line of readBlock(p.anchors)) {
    if (line.type !== "message") continue;
    if (firstIds.has(line.id)) first++;
    else busy++;
  }
  const codes = memberCodes(p.members);
  return {
    period: `${p.period.start} ~ ${p.period.end}`,
    total: p.msgTotal,
    since: p.cutoffAt.slice(0, 10),
    sent: p.msgSent,
    first,
    busy,
    masked: Object.values(p.maskCounts).reduce((a, b) => a + b, 0),
    excluded,
    legend: p.members.map((name, i) => ({ code: codes[i], name })),
    preview: [...legendText(p.members).split("\n"), ...p.transcript.split("\n").slice(0, 20)],
  };
}
