// 분석 컨셉과 4편 제목(PRD 컨셉 표). 컨셉 선택 화면과 편별 지시가 같이 쓴다.

export const CONCEPTS: Record<"group" | "couple", { title: string; episodes: [string, string, string, string] }> = {
  group: {
    title: "친구·가족 단톡방",
    episodes: ["이 방의 연대기", "멤버 캐릭터 카드", "명장면", "이 방이 굴러가는 법"],
  },
  couple: {
    title: "연애·썸",
    episodes: ["우리 대화의 지도", "누가 먼저, 얼마나 빨리", "표현이 바뀐 구간", "너에게 쓰는 편지"],
  },
};
