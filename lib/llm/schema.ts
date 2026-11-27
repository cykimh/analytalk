// 리포트 출력 스키마(v2 설계 G7). 구조만 강제하고 길이·근거·구성 키는 validateReport가 저장 전에 맞춘다.
// 속성 순서가 곧 생성 순서다: safety를 앞에 둬서 응답이 끊겨도 판정이 남고, reading_notes가 먼저 와서 진행 화면에 보이고,
// 근거는 섹션 안에 둬서 끊긴 응답에서 완결된 섹션(= 앞 구성들)을 근거와 함께 살린다. 모든 속성은 required다.
// SDK 스키마 변환은 enum을 강제하지 않으므로 part는 z.enum이 아니라 z.string으로 받는다(오타 하나로 리포트 전체가 failed가 되지 않게).
import { z } from "zod";

export const SAFETY_FLAGS = ["none", "self_harm", "violence", "minor", "abuse"] as const;
/** 금지 주제라 다루지 않은 것(system 프롬프트의 금지 목록과 같은 갈래) */
export const DECLINED_TOPICS = [
  "inner_feelings",
  "scores",
  "diagnosis",
  "personality_type",
  "sexuality",
  "health",
  "religion",
  "politics",
  "appearance",
] as const;

const readingNote = z.object({
  range: z.string().describe("읽은 날짜 범위 MM-DD~MM-DD"),
  note: z.string().describe("60자 이하 메모"),
});

const paragraph = z.object({
  key: z.string(),
  text: z.string().describe("4~7문장, 250~400자(적어도 250자). 숫자는 {{stat:경로}}로만 쓴다"),
  evidence_ids: z.array(z.string()),
});

const evidence = z.object({
  id: z.string(),
  msg_id: z.string().describe("줄 앞의 m번호 그대로"),
  quote: z.string().describe("그 메시지 본문을 글자 그대로 잘라 온 부분"),
});

const section = z.object({
  part: z.string().describe("리포트 구성 키(지시의 구성 목록)"),
  icon: z.string(),
  title: z.string(),
  about: z.string().describe("pair | group | 참여자 표시 이름"),
  paragraphs: z.array(paragraph),
  evidence: z.array(evidence),
});

export const reportSchema = z.object({
  safety: z.object({ flag: z.enum(SAFETY_FLAGS) }),
  declined_topics: z.array(z.enum(DECLINED_TOPICS)),
  reading_notes: z.array(readingNote),
  headline: z.string(),
  dek: z.string(),
  sections: z.array(section),
});

export type Report = z.infer<typeof reportSchema>;

/**
 * 검증이 문단·근거를 지운 까닭(v2.4). 문단: empty(빈 글)·placeholder(풀리지 않는 자리표시자)·too_long·banned(금지 표현)·pii.
 * 근거: evidence_unmatched(원문과 맞지 않고 다시 이을 곳도 없음)·evidence_orphan(남은 문단이 안 씀)·evidence_over_budget(인용 몫 초과).
 * inline_quote·fake_evidence·ungrounded는 v2.4 행에만 있다(v2.5부터 그런 문단을 지우지 않는다: 따옴표만 떼거나 근거 id만 뺀다)
 */
export const DROP_REASONS = [
  "empty",
  "placeholder",
  "too_long",
  "banned",
  "pii",
  "inline_quote",
  "fake_evidence",
  "ungrounded",
  "evidence_unmatched",
  "evidence_orphan",
  "evidence_over_budget",
] as const;
export type DropReason = (typeof DROP_REASONS)[number];
/**
 * 저장하는 검증 기록. 숫자·열거값뿐이다(대화 원문·이름 없음).
 * - relinked: m번호가 틀려 quote가 든 다른 메시지로 다시 이은 근거 수
 * - requoted(v2.5): 정규화·글자 겹침으로 맞춰 quote를 그 메시지의 원문 글자로 바꾼 근거 수
 * - unquoted(v2.5): 원문과 안 맞아 따옴표 문자만 뗀 글 안 인용 수
 * - calls(v2.5): 나눠 쓴 호출마다 결과(ok 또는 오류 코드: max_tokens·timeout·refused·retryable·fatal·limit·invalid_output·not_started)
 * - off_stage(v2.5): 다른 호출 몫의 구성이거나 앞 호출과 같은 사람이라 뺀 섹션 수(삭제율에 넣지 않는다)
 */
export type ValidationChecks = {
  relinked: number;
  requoted: number;
  unquoted: number;
  dropped_by: Partial<Record<DropReason, number>>;
  calls?: Record<string, string>;
  off_stage?: number;
};

/**
 * 저장하는 리포트. 근거에는 페이로드에서 찾은 발신자 표시 이름과 시각(ISO +09:00)을 채운다. part는 구성 키이거나 "".
 * checks는 v2.4부터 저장한다(예전 행에는 없고, v2.4 행에는 requoted·unquoted·calls가 없다)
 */
export type StoredReport = Omit<Report, "sections"> & {
  checks?: ValidationChecks;
  sections: (Omit<Report["sections"][number], "evidence"> & {
    evidence: { id: string; msg_id: string; quote: string; sender: string; at: string }[];
  })[];
};
