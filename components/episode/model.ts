// 대화 홈·리포트 화면의 순수 로직(API 응답 → 화면 상태·문구). DOM 없이 테스트한다.
import { formatCount, kstDate } from "@/components/stats/format";
import { PEOPLE_PART_KEYS, type Tone } from "@/lib/llm/concepts";
import type { StoredReport } from "@/lib/llm/schema";
import type { ChatStats } from "@/lib/stats/compute";

/** 리포트 한 편의 상태·내용 */
export interface ReportState {
  status: string;
  content: StoredReport | null;
  errorCode: string | null;
}

/** GET /api/conversations/[id] */
export interface ConversationView {
  concept: "group" | "couple";
  kind: "pair" | "group" | "work";
  tone: Tone;
  displayNames: string[];
  stats: ChatStats;
  /** transcript 첫 메시지 시각(ISO) */
  cutoffAt: string;
  msgSent: number;
  /** 자동 삭제 시각(ISO) */
  expiresAt: string;
  /** 공유 링크가 살아 있다(토큰 해시는 오지 않는다) */
  shared: boolean;
  report: ReportState;
}

/** GET /api/conversations/[id]/status */
export interface StatusView {
  report: { status: string; progress: unknown; errorCode: string | null };
  /** 전역 정지 중(새 생성·다시 쓰기가 423) */
  paused: boolean;
}

export type Note = { range: string; note: string };

/** safety 리포트(도움 안내). 어느 신호였는지는 저장하지 않아 한 문구로 안내한다 */
export const SAFETY_HELP =
  "걱정되는 이야기가 보여서 리포트를 쓰지 않았어요. 힘들 때는 109(자살예방상담전화, 24시간), 위험할 때는 112·1366(여성긴급전화, 24시간)에서 도와줘요.";
export const AI_NOTICE = "AI 생성, 재미·참고용";
/** 리포트 표지 제목(대화 홈·공유 화면·처음 화면의 내 연재) */
export const SERIES_TITLE: Record<ConversationView["concept"], string> = { couple: "둘의 대화 연재", group: "단톡방 연재" };
export const PAUSED_TEXT = "이번 달 AI 마감";
export const RETRY_KEPT_TEXT = "다시 쓰지 못해서 앞의 글을 그대로 뒀어요.";

/**
 * [다시 쓰기]가 실패해 앞의 글을 남긴 리포트. 서버(finish_episode)는 그때 partial에 이번 실패의 오류 코드를 남긴다.
 * 끊긴 응답을 살린 partial은 오류 코드가 없고, 다시 쓰기를 시작하면 오류 코드를 비운다
 */
export const retryKept = (status: string, errorCode: string | null) => status === "partial" && errorCode !== null;

/** 서버가 지금 쓰고 있거나 곧 쓸 리포트다(폴링을 계속한다) */
export const isActive = (status: string) => status === "running" || status === "queued";

/** 페이로드를 다시 쓸 리포트(queued·running·failed·partial)가 아니다. 이 브라우저의 페이로드를 지운다 */
const NEEDS_PAYLOAD = new Set(["queued", "running", "failed", "partial"]);
export const isSettled = (status: string) => !NEEDS_PAYLOAD.has(status);

const isNote = (v: unknown): v is Note =>
  typeof v === "object" && v !== null && typeof (v as Note).range === "string" && typeof (v as Note).note === "string";

/**
 * 지금까지 본 reading_notes에 새로 온 메모를 붙인다(같은 메모는 한 번). 바뀐 것이 없으면 prev를 그대로 돌려준다.
 * 다시 쓰기가 시작돼 progress가 비어도 쌓인 메모는 남는다
 */
export function mergeNotes(prev: Note[], progress: unknown): Note[] {
  if (!Array.isArray(progress)) return prev;
  const fresh: Note[] = [];
  for (const item of progress) {
    if (!isNote(item)) continue;
    const dup = [...prev, ...fresh].some((n) => n.range === item.range && n.note === item.note);
    if (!dup) fresh.push({ range: item.range, note: item.note });
  }
  return fresh.length === 0 ? prev : [...prev, ...fresh];
}

/** 리포트 카드의 상태 줄. 쓰기 시작 전(메모 없음)에는 읽는 중이다 */
export function reportPhase(status: string, hasNote: boolean): string {
  switch (status) {
    case "queued":
      return "AI가 대화를 읽는 중";
    case "running":
      return hasNote ? "쓰는 중" : "AI가 대화를 읽는 중";
    case "done":
      return "다 썼어요";
    case "partial":
      return "일부만 썼어요";
    case "failed":
      return "쓰지 못했어요";
    case "refused":
      return "AI가 이 대화로는 리포트를 쓰지 않았어요";
    case "safety":
      return "리포트를 쓰지 않았어요";
    default:
      return status;
  }
}

/** 리포트 카드의 버튼: done·partial이면 [리포트 읽기], failed·partial이면 [다시 쓰기](정지 중이면 마감 안내) */
export function reportAction(status: string, paused: boolean): { read: boolean; retry: "button" | "paused" | null } {
  const read = status === "done" || status === "partial";
  const retryable = status === "failed" || status === "partial";
  return { read, retry: retryable ? (paused ? "paused" : "button") : null };
}

/** ISO 시각 → KST 날짜 YYYY-MM-DD */
export const kstDay = (iso: string) => kstDate(Date.parse(iso));

/** ISO 시각 → KST "YYYY-MM-DD HH:mm". 시각이 아니면 빈 글자 */
export function formatAt(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "";
  const d = new Date(ts + 9 * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${kstDate(ts)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** 읽은 범위 "전체 기간에서 N개". 대화가 길면 처음부터 끝까지 고르게 골라 보낸다(lib/payload/build). N은 보낸 메시지 수 */
export const readRange = (msgSent: number) => `전체 기간에서 ${formatCount(msgSent)}개`;

/**
 * 편 카드의 버튼: 내용이 있으면 [읽기], failed·partial이면 [다시 쓰기](정지 중이면 마감 안내).
 * 1편 queued도 [다시 쓰기]다: 정상 흐름은 생성 응답(202) 전에 1편을 running으로 바꾸므로, 화면이 보는 queued 1편은
 * claim 뒤 시작 전에 유실된 것이다(그대로 두면 폴링만 계속된다). 서버가 그사이 시작했으면 다시 쓰기는 409다
 */
export function episodeAction(status: string, paused: boolean, n = 0): { read: boolean; retry: "button" | "paused" | null } {
  const read = status === "done" || status === "partial";
  const retryable = status === "failed" || status === "partial" || (n === 1 && status === "queued");
  return { read, retry: retryable ? (paused ? "paused" : "button") : null };
}

type Section = StoredReport["sections"][number];

/**
 * 근거 말풍선을 그 근거를 처음 쓴 문단 바로 아래에 둔다(v2.2: 섹션이 문단 3~5개로 길어져 인용이 문단과 멀어지지 않게).
 * 어느 문단도 쓰지 않는 근거(예전 리포트)는 섹션 끝에 둔다. index는 섹션 안 근거 순서 그대로다
 */
export function placeEvidence(section: Section): { paragraph: Section["paragraphs"][number] | null; evidence: { e: Section["evidence"][number]; index: number }[] }[] {
  const order = new Map(section.evidence.map((e, i) => [e.id, i]));
  const shown = new Set<string>();
  const take = (ids: string[]) =>
    ids.flatMap((id) => {
      const index = order.get(id);
      if (index === undefined || shown.has(id)) return [];
      shown.add(id);
      return [{ e: section.evidence[index], index }];
    });
  const rows = section.paragraphs.map((paragraph) => ({ paragraph, evidence: take(paragraph.evidence_ids) }));
  const rest = take(section.evidence.map((e) => e.id));
  return rest.length > 0 ? [...rows, { paragraph: null, evidence: rest }] : rows;
}

/** 리포트의 세 부분(v2.4): 인트로 종합 → 멤버별(개인별 특징) → 마무리 */
export type ReportStage = "intro" | "people" | "outro";
export const STAGE_LABEL: Record<ReportStage, string> = { intro: "종합", people: "멤버별", outro: "마무리" };

/** 사람을 다루는 섹션: 개인별 구성 키(people·others)이거나 about이 참여자 이름 */
const isPeopleSection = (s: Pick<Section, "part" | "about">) =>
  PEOPLE_PART_KEYS.has(s.part) || (s.about !== "group" && s.about !== "pair" && s.about !== "");

/**
 * 저장된 섹션을 세 부분으로 나눈다(v2.4). 저장 순서를 바꾸지 않고 자리로 정한다: 첫 사람 섹션 앞은 종합, 첫 사람 섹션부터
 * 마지막 사람 섹션까지는 멤버별, 그 뒤는 마무리. 구성 키가 없거나("") 예전 구성(v2.3까지)인 행도 같은 규칙으로 나뉜다.
 * 사람 섹션이 없으면 한 부분(종합)뿐이다(화면은 머리말을 그리지 않는다). index는 리포트 전체에서 섹션 순서다
 */
export function groupStages<S extends Pick<Section, "part" | "about">>(
  sections: readonly S[],
): { stage: ReportStage; sections: { section: S; index: number }[] }[] {
  const rows = sections.map((section, index) => ({ section, index }));
  const first = sections.findIndex(isPeopleSection);
  if (first < 0) return rows.length === 0 ? [] : [{ stage: "intro", sections: rows }];
  const last = sections.findLastIndex(isPeopleSection);
  const groups: { stage: ReportStage; sections: { section: S; index: number }[] }[] = [
    { stage: "intro", sections: rows.slice(0, first) },
    { stage: "people", sections: rows.slice(first, last + 1) },
    { stage: "outro", sections: rows.slice(last + 1) },
  ];
  return groups.filter((g) => g.sections.length > 0);
}
