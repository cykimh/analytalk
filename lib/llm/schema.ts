// 편 출력 스키마(PRD 5장 출력 스키마). 구조만 강제하고 길이·근거는 validateEpisode가 저장 전에 맞춘다.
// 속성 순서가 곧 생성 순서다: safety를 앞에 둬서 응답이 끊겨도 판정이 남고, 근거는 섹션 안에 둬서
// 끊긴 응답에서 완결된 섹션을 근거와 함께 살린다. 모든 속성은 required이고 없을 수 있는 값은 nullable이다.
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
  icon: z.string(),
  title: z.string(),
  about: z.string().describe("me | pair | group | 참여자 표시 이름"),
  paragraphs: z.array(paragraph),
  evidence: z.array(evidence),
});

export const episodeSchema = z.object({
  episode: z.number().int().min(1).max(4),
  safety: z.object({ flag: z.enum(SAFETY_FLAGS) }),
  declined_topics: z.array(z.enum(DECLINED_TOPICS)),
  reading_notes: z.array(readingNote),
  headline: z.string(),
  dek: z.string(),
  sections: z.array(section),
  next_teaser: z.string().nullable().describe("마지막 편이면 null"),
});

export type Episode = z.infer<typeof episodeSchema>;

/** 저장하는 편. 근거에는 페이로드에서 찾은 발신자 표시 이름과 시각(ISO +09:00)을 채운다 */
export type StoredEpisode = Omit<Episode, "sections"> & {
  sections: (Omit<Episode["sections"][number], "evidence"> & {
    evidence: { id: string; msg_id: string; quote: string; sender: string; at: string }[];
  })[];
};
