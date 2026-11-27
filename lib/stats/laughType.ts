// 멤버별 'ㅋ 유형'(v2.8). laughLength(ㅋ·ㅎ를 한 번에 몇 개씩 이어 쓰는지) 히스토그램으로 사람마다 유형 하나를 고른다.
// 통계로만 정한다(AI 비용 없음). 리포트·공유 화면의 사람 섹션 머리에 칩으로 보인다. 기준값은 아래 상수이고 laughType.test가 고정한다.

export type LaughType = "deadpan" | "restrained" | "classic" | "burst" | "maniac";

export const LAUGH_TYPE_LABEL: Record<LaughType, string> = {
  deadpan: "무표정형",
  restrained: "절제형",
  classic: "정석형",
  burst: "폭발형",
  maniac: "광기형",
};

/** 칩에 붙이는 짧은 설명(title) */
export const LAUGH_TYPE_HINT: Record<LaughType, string> = {
  deadpan: "웃음이 거의 없어요",
  restrained: "ㅋ를 주로 1~2개",
  classic: "ㅋ를 주로 3~4개",
  burst: "ㅋ를 주로 5~9개",
  maniac: "ㅋ를 10개 넘게 이어 쓰는 일이 잦아요",
};

export const LAUGH_TYPE_RULES = {
  /** 메시지가 이보다 적으면 데이터가 모자라 유형을 정하지 않는다 */
  minMessages: 20,
  /** 웃음(ㅋ·ㅎ 덩어리) 수 ÷ 메시지 수가 이보다 작으면 무표정형(메시지 20개에 웃음 1번 꼴 미만) */
  deadpanRate: 0.05,
  /** 10개 이상 덩어리가 웃음의 이만큼 이상이면 가운데 길이와 상관없이 광기형 */
  maniacShare: 0.25,
} as const;

/** 가운데 길이(아래쪽 중앙값)로 고르는 칸: 1~2 절제형, 3~4 정석형, 5~9 폭발형, 10 이상 광기형 */
const byMedian = (len: number): LaughType => (len <= 2 ? "restrained" : len <= 4 ? "classic" : len <= 9 ? "burst" : "maniac");

/**
 * 한 사람의 ㅋ 유형. hist는 laughLength[이름](길이 11, 인덱스 = 길이, 10은 10 이상), messages는 그 사람의 메시지 수(byPerson).
 * 메시지가 LAUGH_TYPE_RULES.minMessages개 미만이면 null(데이터 부족). 히스토그램이 없으면(글 없이 사진만) 웃음 0번으로 본다
 */
export function laughType(hist: readonly number[] | undefined, messages: number): LaughType | null {
  if (!(messages >= LAUGH_TYPE_RULES.minMessages)) return null;
  const counts = Array.from({ length: 10 }, (_, i) => hist?.[i + 1] ?? 0);
  const runs = counts.reduce((a, b) => a + b, 0);
  if (runs / messages < LAUGH_TYPE_RULES.deadpanRate) return "deadpan";
  if (counts[9] / runs >= LAUGH_TYPE_RULES.maniacShare) return "maniac";
  // 길이 순으로 늘어놓았을 때 아래쪽 가운데(0부터 floor((runs - 1) / 2)번째) 덩어리의 길이
  const middle = Math.floor((runs - 1) / 2);
  let seen = 0;
  for (let i = 0; i < counts.length; i++) {
    seen += counts[i];
    if (seen > middle) return byMedian(i + 1);
  }
  return "deadpan";
}
