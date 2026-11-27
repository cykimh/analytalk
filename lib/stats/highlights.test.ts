import { describe, expect, it } from "vitest";
import { type ChatStats, computeStats } from "./compute";
import { HIGHLIGHT_RULES, highlightCards } from "./highlights";

/** 빈 통계에 필요한 칸만 채운다 */
const stats = (over: Partial<ChatStats>): ChatStats => ({ ...computeStats([]), ...over });

/** 날짜 n일(2026-10-01부터)에 하루 perDay개씩 */
const days = (n: number, perDay: number) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`2026-10-${String(i + 1).padStart(2, "0")}`, perDay]));

const MIN = 60_000;

/** 1:1(민지·철수) 대화: 모든 카드가 나올 만큼 채운 통계 */
const pair = stats({
  total: 600,
  byPerson: { 민지: 320, 철수: 280 },
  initiations: { 민지: 31, 철수: 19 },
  laughChars: { 민지: 5231, 철수: 840 },
  nightRatio: 0.38,
  replyMedianMs: { 민지: 1 * MIN, 철수: 12 * MIN },
  longestStreakDays: 28,
  dailyCounts: days(30, 20),
  busiestDay: { date: "2026-10-04", count: 20 },
  questionRate: { 민지: 0.12, 철수: 0.23 },
  media: { 민지: { photo: 40, emoticon: 0, link: 0 }, 철수: { photo: 3, emoticon: 0, link: 0 } },
});

describe("highlightCards (v2.8 리포트 맨 위 한 줄 카드)", () => {
  it("기준값을 상수로 고정한다", () => {
    expect(HIGHLIGHT_RULES).toEqual({
      maxCards: 6,
      minInitiations: 5,
      minLaughChars: 10,
      minNightRatio: 0.05,
      minReplyMessages: 10,
      minStreakDays: 3,
      minPeriodDays: 2,
      minQuestionMessages: 20,
      minPhotos: 5,
    });
  });

  it("1:1: 재미있는 순서로 6장까지(케미 → 먼저 말 걸기 → ㅋ → 새벽 → 답장 → 연속 → 하루 평균 → 물음표 → 사진)", () => {
    const cards = highlightCards(pair, { chemistry: { score: 78, line: "둘은 이미 한 팀이다" } });
    expect(cards.map((c) => [c.key, c.label, c.value])).toEqual([
      ["chemistry", "케미 온도", "78°"],
      ["initiations", "먼저 말 거는 쪽", "민지 62% vs 철수 38%"],
      ["laugh", "ㅋ 폭격기 1위", "민지 · ㅋ 5,231개"],
      ["night", "새벽 대화(밤 10시~새벽 5시)", "38%"],
      ["reply", "답장 속도(중앙값)", "민지 1분 · 철수 12분"],
      ["streak", "최장 연속 대화", "28일"],
    ]);
    expect(cards[0].note).toBe("둘은 이미 한 팀이다");
    for (const c of cards) expect([...c.emoji].length).toBeLessThanOrEqual(2);
  });

  it("케미 온도가 없거나(예전 리포트) 범위 밖이면 그 카드는 빼고 다음 카드가 들어온다", () => {
    expect(highlightCards(pair).map((c) => c.key)).toEqual(["initiations", "laugh", "night", "reply", "streak", "daily"]);
    for (const score of [-1, 101, 78.5, Number.NaN]) {
      expect(highlightCards(pair, { chemistry: { score, line: "" } })[0].key).toBe("initiations");
    }
    // 빈 한 줄은 메모 없이
    expect(highlightCards(pair, { chemistry: { score: 0, line: " " } })[0]).toMatchObject({ value: "0°", note: undefined });
  });

  it("하루 평균은 기간 날수(양 끝 포함)로 나누고, 물음표·사진은 앞 카드가 빠질 때 들어온다", () => {
    const quiet = stats({ ...pair, initiations: { 민지: 1, 철수: 1 }, laughChars: undefined, nightRatio: 0, longestStreakDays: 1 });
    expect(highlightCards(quiet).map((c) => [c.key, c.value])).toEqual([
      ["reply", "민지 1분 · 철수 12분"],
      ["daily", "20개"],
      ["question", "철수 · 글 메시지의 23%"],
      ["photo", "민지 · 40장"],
    ]);
  });

  it("단톡: 대화 시작 1위·답장 제일 빠른 사람은 한 사람을 고른다(동률은 이름 순)", () => {
    const group = stats({
      total: 900,
      byPerson: { 영희: 300, 민지: 300, 철수: 300 },
      initiations: { 영희: 20, 민지: 20, 철수: 9 },
      laughChars: { 영희: 30, 민지: 12, 철수: 0 },
      replyMedianMs: { 영희: 3 * MIN, 민지: 2 * MIN, 철수: null },
    });
    const cards = highlightCards(group);
    expect(cards.find((c) => c.key === "initiations")).toMatchObject({ label: "대화 시작 1위", value: "민지 · 전체의 41%" });
    expect(cards.find((c) => c.key === "laugh")).toMatchObject({ value: "영희 · ㅋ 30개" });
    expect(cards.find((c) => c.key === "reply")).toMatchObject({ label: "답장 제일 빠른 사람", value: "민지 · 중앙값 2분" });
  });

  it("숫자가 의미 없으면(0·데이터 부족) 그 카드는 뺀다. 빈 통계는 카드가 없다", () => {
    expect(highlightCards(computeStats([]))).toEqual([]);
    const thin = stats({
      total: 12,
      byPerson: { 민지: 6, 철수: 6 },
      initiations: { 민지: 2, 철수: 2 },
      laughChars: { 민지: 9, 철수: 0 },
      nightRatio: 0.04,
      replyMedianMs: { 민지: MIN, 철수: MIN },
      longestStreakDays: 2,
      dailyCounts: { "2026-10-01": 12 },
      questionRate: { 민지: 0.5, 철수: 0 },
      media: { 민지: { photo: 4, emoticon: 0, link: 0 }, 철수: { photo: 0, emoticon: 0, link: 0 } },
    });
    expect(highlightCards(thin)).toEqual([]);
  });

  it("가장 뜨거웠던 날은 폴라로이드와 겹쳐 카드로 만들지 않는다", () => {
    expect(highlightCards(pair).map((c) => c.key)).not.toContain("busiest");
  });
});
