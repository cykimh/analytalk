// 업로드 흐름의 순수 로직(화면 상태 → 이름 맵·확인 문구). DOM 없이 테스트한다.
import { ANCHOR_FIRST_N } from "@/lib/config";
import { type Payload, readBlock } from "@/lib/payload/build";
import { applyDisplayNames, type NameError, type NameMap } from "@/lib/payload/names";
import type { ChatMessage, ParseResult } from "@/lib/parse/parse";

export type Kind = Payload["kind"];

export const KIND_LABEL: Record<Kind, string> = { pair: "1:1", group: "친구·가족 단톡", work: "직장·팀" };

/** 방 종류 기본값: 발신자가 2명 이하면 1:1, 그 밖은 단톡 */
export const defaultKind = (participants: number): Kind => (participants <= 2 ? "pair" : "group");

/** 컨셉은 kind에 맞는 것만 쓴다. 직장·팀은 AI가 꺼져 있고(M3) 통계용 페이로드만 group으로 만든다 */
export const conceptFor = (kind: Kind): Payload["concept"] => (kind === "pair" ? "couple" : "group");

/** 줄 인식률(%) 정수. 내려서 98% 미만이 98%로 보이지 않게 한다 */
export const recognitionPercent = (ratio: number) => Math.floor(ratio * 100 + 1e-9);

/** 이름을 정할 원래 이름: 발신자(처음 나온 순서), 그다음 초대·나감 알림에만 나온 이름 */
export function nameTargets(parse: Pick<ParseResult, "participants" | "systemNames">): string[] {
  return [...new Set([...parse.participants, ...parse.systemNames])].filter((n) => n !== "");
}

export interface NameState {
  /** 원래 이름 → 입력한 표시 이름. 합쳐진 사람은 대표의 값을 쓴다 */
  names: Record<string, string>;
  /** [같은 사람]: 원래 이름 → 대표 원래 이름. 대표는 키가 아니다 */
  sameAs: Record<string, string>;
}

/** 기본 표시 이름은 멤버1…(원래 이름을 그대로 두지 않는다) */
export function initialNames(targets: string[]): NameState {
  return { names: Object.fromEntries(targets.map((t, i) => [t, `멤버${i + 1}`])), sameAs: {} };
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

/** 지금 이름으로 [다음]을 막을 이유. applyDisplayNames와 같은 판정이다(본문은 넘기지 않아 바로 끝난다) */
export function nameProblem(state: NameState, targets: string[]): NameError | null {
  const r = applyDisplayNames([], nameMapOf(state, targets), targets, mergedGroups(state.sameAs));
  return r.ok ? null : r.reason;
}

export const NAME_PROBLEM_TEXT: Record<NameError, string> = {
  empty: "비어 있는 이름이 있어요. 모든 사람에게 표시 이름을 정해 주세요.",
  invalid: "이름은 20자까지, | . { } < > 와 줄바꿈 같은 쓸 수 없는 글자 없이 정해 주세요.",
  collision: "두 사람에게 같은 이름을 줄 수 없어요. 같은 사람이면 [같은 사람]으로 합쳐 주세요.",
  unmapped: "이름을 정하지 않은 사람이 있어요.",
};

/**
 * 남은 조각을 바꿀 표시 이름 제안. 조각을 품은 원래 이름(대소문자 무시)이 모두 같은 표시 이름이면 그 이름, 아니면 null.
 * 조각은 모두 원래 이름의 일부다(names.ts nameKeys)
 */
export function leftoverOwner(piece: string, map: NameMap): string | null {
  const p = piece.toLowerCase();
  const owners = new Set(Object.entries(map).flatMap(([name, shown]) => (name.toLowerCase().includes(p) ? [shown] : [])));
  return owners.size === 1 ? [...owners][0] : null;
}

export interface SendSummary {
  /** transcript 첫 메시지의 KST 날짜 */
  since: string;
  sent: number;
  /** anchors 중 첫 대화(시스템 메시지를 뺀 처음 ANCHOR_FIRST_N개)와 가장 활발했던 날 메시지 수 */
  first: number;
  busy: number;
  masked: number;
  preview: string[];
}

/** 보낼 내용 확인 화면의 숫자. messages는 페이로드를 만든 메시지(이름 정리 뒤) */
export function sendSummary(p: Payload, messages: ChatMessage[]): SendSummary {
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
  return {
    since: p.cutoffAt.slice(0, 10),
    sent: p.msgSent,
    first,
    busy,
    masked: Object.values(p.maskCounts).reduce((a, b) => a + b, 0),
    preview: p.transcript.split("\n").slice(0, 20),
  };
}
