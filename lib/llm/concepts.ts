// 분석 컨셉(방 종류)과 말투(v2 설계 G7, v2.2). 컨셉 선택 화면·리포트 지시·검증이 같이 쓴다.
// v2.2: 리포트 구성(part)은 말투가 정한다. 말투마다 그 컨셉의 형식(잔소리 카드, 상담 일지, 예능 중계…)으로 구성이 다르고,
// 방 종류(컨셉)는 무엇을 소재로 쓸지만 정한다.
// v2.3: '다정한 상담 선생님'과 '담임의 생활기록부'가 겹쳐서 warm 하나('담임 선생님')로 합쳤다. record는 고르기 화면·새 요청에서 빠지고
// 예전 행(DB check·최근 목록·저장된 리포트)을 읽으려고 키·라벨·구성만 남는다.
// v2.4: 모든 말투가 인트로 종합 → 개인별 → 마무리 뼈대를 쓴다(Stage). 말투는 각 자리의 제목·목소리·형식을 정한다.

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
 * 구성의 자리(v2.4). 모든 말투가 같은 뼈대를 쓴다: 인트로 종합(intro, 섹션 1~2개) → 개인별(people: 상위 멤버마다 섹션 하나,
 * others: 그 밖의 멤버를 섹션 하나에 한 문단씩) → 마무리(outro, 섹션 1~2개). 말투는 각 자리의 제목·목소리·형식을 정한다
 */
export type Stage = "intro" | "people" | "others" | "outro";

/**
 * 말투별 리포트 구성(v2.4). 섹션의 part가 이 키다. 키는 말투끼리 겹치지 않는다(평가의 구성별 삭제율이 섞이지 않게).
 * 배열 순서가 리포트 순서이고 stage 순서(intro → people → others → outro)를 따른다(prompt.test가 확인한다).
 * 예전 행과 평가 기록이 이어지게 v2.3까지 쓰던 키는 되도록 그대로 두고 자리·제목만 옮겼다
 */
const PARTS = {
  fact: [
    { key: "nag_open", title: "첫 잔소리", stage: "intro" },
    { key: "nag_room", title: "이 방 전체에 하는 잔소리", stage: "intro" },
    { key: "nag_cards", title: "사람별 잔소리 카드", stage: "people" },
    { key: "nag_others", title: "그 밖의 멤버 한 줄 잔소리", stage: "others" },
    { key: "nag_last", title: "마지막 한마디", stage: "outro" },
  ],
  // 담임 선생님: 예전 warm 행과 평가 기록이 이어지게 키(care_*)는 그대로 둔다
  warm: [
    { key: "care_open", title: "학급 개요", stage: "intro" },
    { key: "care_habits", title: "이 반의 좋은 습관", stage: "intro" },
    { key: "care_people", title: "학생별 종합 의견", stage: "people" },
    { key: "care_others", title: "그 밖의 학생들", stage: "others" },
    { key: "care_advice", title: "서로에게 건네는 조언", stage: "outro" },
    { key: "care_letter", title: "담임의 편지", stage: "outro" },
  ],
  show: [
    { key: "show_open", title: "오프닝", stage: "intro" },
    { key: "show_vcr", title: "하이라이트 VCR", stage: "intro" },
    { key: "show_cast", title: "출연자 소개", stage: "people" },
    { key: "show_others", title: "그 밖의 출연자", stage: "others" },
    { key: "show_corner", title: "이 방 시상식", stage: "outro" },
    { key: "show_close", title: "클로징", stage: "outro" },
  ],
  docu: [
    { key: "docu_habitat", title: "서식지", stage: "intro" },
    { key: "docu_seasons", title: "계절의 변화", stage: "intro" },
    { key: "docu_life", title: "개체별 관찰", stage: "people" },
    { key: "docu_others", title: "그 밖의 개체들", stage: "others" },
    { key: "docu_moment", title: "결정적 장면", stage: "outro" },
    { key: "docu_outro", title: "내레이션 마무리", stage: "outro" },
  ],
  detective: [
    { key: "case_brief", title: "사건 개요", stage: "intro" },
    { key: "case_timeline", title: "사건 재구성", stage: "intro" },
    { key: "case_people", title: "관련자 프로필", stage: "people" },
    { key: "case_others", title: "그 밖의 관련자", stage: "others" },
    { key: "case_open", title: "미해결 의문", stage: "outro" },
    { key: "case_verdict", title: "수사 결론", stage: "outro" },
  ],
  // 예전 행 전용(v2.3부터 고를 수 없다). 저장된 record 리포트의 구성 키를 그대로 읽는다
  record: [
    { key: "rec_class", title: "학급 개요", stage: "intro" },
    { key: "rec_students", title: "학생별 행동 특성 및 종합 의견", stage: "people" },
    { key: "rec_attendance", title: "출결·참여 특기사항", stage: "outro" },
    { key: "rec_overall", title: "담임 총평", stage: "outro" },
  ],
} as const satisfies Record<Tone, readonly { key: string; title: string; stage: Stage }[]>;

/** 리포트 구성 키. 섹션의 part가 이 값이다 */
export type PartKey = (typeof PARTS)[Tone][number]["key"];
/** 그 말투의 구성 키 */
export type PartOf<T extends Tone> = (typeof PARTS)[T][number]["key"];
export type Part = { key: PartKey; title: string; stage: Stage };

export const TONES: Record<Tone, { label: string; parts: readonly Part[] }> = {
  fact: { label: "잔소리하는 친구", parts: PARTS.fact },
  warm: { label: "담임 선생님", parts: PARTS.warm },
  show: { label: "예능 MC 중계", parts: PARTS.show },
  docu: { label: "자연 다큐 내레이터", parts: PARTS.docu },
  detective: { label: "탐정 사건 보고서", parts: PARTS.detective },
  // 예전 record 리포트도 합친 말투 이름으로 보인다
  record: { label: "담임 선생님", parts: PARTS.record },
};

/**
 * 사람을 다루는 구성 키(개인별 자리: people·others). 리포트 화면이 저장된 섹션을 종합·멤버별·마무리로 나눌 때 쓴다.
 * v2.3까지만 쓰던 키(case_exhibits 등)는 사람 구성이 아니라 여기 없다
 */
export const PEOPLE_PART_KEYS: ReadonlySet<string> = new Set(
  Object.values(PARTS).flatMap((parts) => parts.filter((p) => p.stage === "people" || p.stage === "others").map((p) => p.key)),
);
