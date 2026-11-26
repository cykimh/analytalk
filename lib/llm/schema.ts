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
  text: z.string().describe("숫자는 {{stat:경로}}로만 쓴다"),
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

/** 저장하는 리포트. 근거에는 페이로드에서 찾은 발신자 표시 이름과 시각(ISO +09:00)을 채운다. part는 구성 키이거나 "" */
export type StoredReport = Omit<Report, "sections"> & {
  sections: (Omit<Report["sections"][number], "evidence"> & {
    evidence: { id: string; msg_id: string; quote: string; sender: string; at: string }[];
  })[];
};
