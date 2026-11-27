// 분석 컨셉(방 종류)과 말투(v2 설계 G7, v2.2). 컨셉 선택 화면·리포트 지시·검증이 같이 쓴다.
// v2.2: 리포트 구성(part)은 말투가 정한다. 말투마다 그 컨셉의 형식(잔소리 카드, 상담 일지, 예능 중계…)으로 구성이 다르고,
// 방 종류(컨셉)는 무엇을 소재로 쓸지만 정한다.
// v2.3: '다정한 상담 선생님'과 '담임의 생활기록부'가 겹쳐서 warm 하나('담임 선생님')로 합쳤다. record는 고르기 화면·새 요청에서 빠지고
// 예전 행(DB check·최근 목록·저장된 리포트)을 읽으려고 키·라벨·구성만 남는다.

export type Concept = "group" | "couple";

export const CONCEPTS: Record<Concept, { title: string }> = {
  group: { title: "친구·가족 단톡방" },
  couple: { title: "연애·썸" },
};

/**
 * 저장된 리포트가 가질 수 있는 말투 전부. 모두 방 밖의 제3자가 바라본 컨셉이다(v2.1).
 * fact·warm·show는 예전 행·최근 목록과 호환하려고 키를 그대로 두고 뜻만 바꿨다. DB check·최근 목록 검사가 이 목록을 쓴다
 */
export const TONE_KEYS = ["fact", "warm", "show", "docu", "detective", "record"] as const;
export type Tone = (typeof TONE_KEYS)[number];
/**
 * 새 리포트에 고를 수 있는 말투(v2.3, 5개). 순서가 고르기 화면 순서다. 페이로드 검사(zod)가 이 목록만 받아서
 * 새 요청에 record가 오면 400으로 거절한다
 */
export const PICKABLE_TONES = ["fact", "warm", "show", "docu", "detective"] as const;
export type PickableTone = (typeof PICKABLE_TONES)[number];
export const DEFAULT_TONE: PickableTone = "fact";

/**
 * 말투별 리포트 구성. 섹션의 part가 이 키다. 키는 말투끼리 겹치지 않는다(평가의 구성별 삭제율이 섞이지 않게).
 * 사람을 다루는 구성(…_cards·…_people·…_cast 등)은 사람마다 섹션 하나다(지시가 정한다)
 */
const PARTS = {
  fact: [
    { key: "nag_open", title: "오프닝 잔소리" },
    { key: "nag_cards", title: "멤버별 잔소리 카드" },
    { key: "nag_room", title: "이 방 전체에 하는 잔소리" },
    { key: "nag_last", title: "마지막 한마디" },
  ],
  // v2.3 담임 선생님: 예전 warm 행과 평가 기록이 이어지게 키(care_*)는 그대로 두고 제목만 바꿨다
  warm: [
    { key: "care_open", title: "학급 개요" },
    { key: "care_people", title: "학생별 종합 의견" },
    { key: "care_habits", title: "이 반의 좋은 습관" },
    { key: "care_advice", title: "서로에게 건네는 조언" },
    { key: "care_letter", title: "담임의 편지" },
  ],
  show: [
    { key: "show_open", title: "오프닝 멘트" },
    { key: "show_cast", title: "출연자 소개" },
    { key: "show_vcr", title: "하이라이트 VCR" },
    { key: "show_corner", title: "코너: 이 방 랭킹·시상식" },
    { key: "show_close", title: "클로징 멘트" },
  ],
  docu: [
    { key: "docu_habitat", title: "서식지 소개" },
    { key: "docu_life", title: "개체별 생태 관찰" },
    { key: "docu_seasons", title: "계절의 변화" },
    { key: "docu_moment", title: "결정적 장면" },
    { key: "docu_outro", title: "내레이션 마무리" },
  ],
  detective: [
    { key: "case_brief", title: "사건 개요" },
    { key: "case_people", title: "관련자 프로필" },
    { key: "case_exhibits", title: "증거물 목록" },
    { key: "case_timeline", title: "사건 재구성" },
    { key: "case_open", title: "미해결 의문" },
    { key: "case_verdict", title: "수사 결론" },
  ],
  // 예전 행 전용(v2.3부터 고를 수 없다). 저장된 record 리포트의 구성 키를 그대로 읽는다
  record: [
    { key: "rec_class", title: "학급 개요" },
    { key: "rec_students", title: "학생별 행동 특성 및 종합 의견" },
    { key: "rec_attendance", title: "출결·참여 특기사항" },
    { key: "rec_overall", title: "담임 총평" },
  ],
} as const satisfies Record<Tone, readonly { key: string; title: string }[]>;

/** 리포트 구성 키. 섹션의 part가 이 값이다 */
export type PartKey = (typeof PARTS)[Tone][number]["key"];
/** 그 말투의 구성 키 */
export type PartOf<T extends Tone> = (typeof PARTS)[T][number]["key"];

export const TONES: Record<Tone, { label: string; parts: readonly { key: PartKey; title: string }[] }> = {
  fact: { label: "잔소리하는 친구", parts: PARTS.fact },
  warm: { label: "담임 선생님", parts: PARTS.warm },
  show: { label: "예능 MC 중계", parts: PARTS.show },
  docu: { label: "자연 다큐 내레이터", parts: PARTS.docu },
  detective: { label: "탐정 사건 보고서", parts: PARTS.detective },
  // 예전 record 리포트도 합친 말투 이름으로 보인다
  record: { label: "담임 선생님", parts: PARTS.record },
};
