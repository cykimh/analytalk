// 분석 컨셉과 리포트 구성(v2 설계 G7). 컨셉 선택 화면·리포트 지시·검증이 같이 쓴다.

export type Concept = "group" | "couple";
/** 리포트 구성 키. 섹션의 part가 이 값이다 */
export type PartKey = "chronicle" | "characters" | "scenes" | "rhythm" | "map" | "first" | "shift" | "letter";

export const CONCEPTS: Record<Concept, { title: string; parts: readonly { key: PartKey; title: string }[] }> = {
  group: {
    title: "친구·가족 단톡방",
    parts: [
      { key: "chronicle", title: "이 방의 연대기" },
      { key: "characters", title: "멤버 캐릭터 카드" },
      { key: "scenes", title: "명장면" },
      { key: "rhythm", title: "이 방이 굴러가는 법" },
    ],
  },
  couple: {
    title: "연애·썸",
    parts: [
      { key: "map", title: "두 사람의 대화 지도" },
      { key: "first", title: "누가 먼저, 얼마나 빨리" },
      { key: "shift", title: "표현이 바뀐 구간" },
      { key: "letter", title: "두 사람에게 쓰는 편지" },
    ],
  },
};

/**
 * 리포트 말투. 모두 방 밖의 제3자가 바라본 컨셉이다(v2.1).
 * fact·warm·show는 예전 행·최근 목록과 호환하려고 키를 그대로 두고 뜻만 바꿨다. 순서가 고르기 화면 순서다
 */
export const TONE_KEYS = ["fact", "warm", "show", "docu", "detective", "record"] as const;
export type Tone = (typeof TONE_KEYS)[number];
export const DEFAULT_TONE: Tone = "fact";
export const TONES: Record<Tone, { label: string }> = {
  fact: { label: "잔소리하는 친구" },
  warm: { label: "다정한 상담 선생님" },
  show: { label: "예능 MC 중계" },
  docu: { label: "자연 다큐 내레이터" },
  detective: { label: "탐정 사건 보고서" },
  record: { label: "담임의 생활기록부" },
};
