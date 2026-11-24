// 문단 [틀렸어요] 피드백(브라우저·서버 공용). 이유 코드는 feedback.reason check와 같다.
import type { StoredEpisode } from "@/lib/llm/schema";

export const FEEDBACK_REASONS = ["wrong_person", "wrong_fact", "tone", "other"] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

export const FEEDBACK_LABEL: Record<FeedbackReason, string> = {
  wrong_person: "다른 사람 이야기예요",
  wrong_fact: "사실과 달라요",
  tone: "말투가 불편해요",
  other: "그 밖의 이유",
};

/** 문단 키는 모델이 섹션마다 따로 매겨(p1…) 겹칠 수 있어 섹션 번호(저장된 순서, 1부터)를 붙인다 */
export const paragraphRef = (sectionIndex: number, key: string) => `s${sectionIndex + 1}.${key}`;

/** 저장된 편의 문단 키들 */
export const paragraphRefs = (content: StoredEpisode): string[] =>
  content.sections.flatMap((s, i) => s.paragraphs.map((p) => paragraphRef(i, p.key)));
