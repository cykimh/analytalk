import { describe, expect, it } from "vitest";
import { type ChatStats, computeStats } from "./compute";
import { HIGHLIGHT_RULES, highlightCards } from "./highlights";

/** 빈 통계에 필요한 칸만 채운다 */
const stats = (over: Partial<ChatStats>): ChatStats => ({ ...computeStats([]), ...over });

/** 날짜 n일(2026-10-01부터)에 하루 perDay개씩 */
const days = (n: number, perDay: number) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`2026-10-${String(i + 1).padStart(2, "0")}`, perDay]));

const MIN = 60_000;
const hours = (peak: number) => Array.from({ length: 24 }, (_, h) => (h === peak ? 300 : 10));

/** 방 전체 카드가 모두 나올 만큼 채운 통계 */
const room = stats({
  total: 600,
  byPerson: { 민지: 320, 철수: 280 },
  replyMedianAll: 3 * MIN,
  nightRatio: 0.38,
  hourHistogram: hours(21),
  longestStreakDays: 28,
  dailyCounts: days(30, 20),
  busiestDay: { date: "2026-10-04", count: 20 },
});

// v2.9: 사람을 견주는 카드(먼저 말 걸기·ㅋ 폭격기·답장 제일 빠른 사람·물음표·사진)는 '누가 더 ___' 칭호(titles)로 옮기고,
// 하이라이트는 케미 온도와 방 전체 숫자(재치 한 줄 포함)만 남긴다
describe("highlightCards (v2.8 리포트 맨 위 한 줄 카드, v2.9 방 전체 숫자 + 재치 한 줄)", () => {
  it("기준값을 상수로 고정한다", () => {
    expect(HIGHLIGHT_RULES).toEqual({ maxCards: 6, minNightRatio: 0.05, minPeakMessages: 30, minStreakDays: 3, minPeriodDays: 2 });
  });

  it("순서: 케미 온도 → 답장 속도(방 전체) → 새벽 대화 → 가장 수다스러운 시간 → 최장 연속 → 하루 평균. 숫자 카드에는 재치 한 줄", () => {
    const cards = highlightCards(room, { chemistry: { score: 78, line: "둘은 이미 한 팀이다" } });
    expect(cards.map((c) => [c.key, c.label, c.value, c.quip ?? null])).toEqual([
      ["chemistry", "케미 온도", "78°", null],
      ["reply", "답장 속도(방 전체 중앙값)", "3분", "라면 물 끓기 전에 온다"],
      ["night", "새벽 대화(밤 10시~새벽 5시)", "38%", "해 지면 살아나는 방"],
      ["peak", "가장 수다스러운 시간", "저녁 9시", "저녁 먹고 모이는 방"],
      ["streak", "최장 연속 대화", "28일", null],
      ["daily", "하루 평균", "20개", null],
    ]);
    expect(cards[0].note).toBe("둘은 이미 한 팀이다");
    for (const c of cards) expect([...c.emoji].length).toBeLessThanOrEqual(2);
  });

  it("케미 온도가 없거나(예전 리포트) 범위 밖이면 그 카드만 빠진다. 빈 한 줄은 메모 없이", () => {
    expect(highlightCards(room).map((c) => c.key)).toEqual(["reply", "night", "peak", "streak", "daily"]);
    for (const score of [-1, 101, 78.5, Number.NaN]) {
      expect(highlightCards(room, { chemistry: { score, line: "" } })[0].key).toBe("reply");
    }
    expect(highlightCards(room, { chemistry: { score: 0, line: " " } })[0]).toMatchObject({ value: "0°", note: undefined });
  });

  it("예전 통계(replyMedianAll 없음)는 답장 속도 카드만 빠진다", () => {
    const { replyMedianAll: _, ...old } = room;
    expect(highlightCards(old).map((c) => c.key)).toEqual(["night", "peak", "streak", "daily"]);
  });

  it("숫자가 의미 없으면(0·데이터 부족) 그 카드는 뺀다. 빈 통계는 카드가 없다", () => {
    expect(highlightCards(computeStats([]))).toEqual([]);
    const thin = stats({
      total: 12,
      byPerson: { 민지: 6, 철수: 6 },
      replyMedianAll: null,
      nightRatio: 0.04,
      hourHistogram: hours(21).map((n) => Math.min(n, 1)),
      longestStreakDays: 2,
      dailyCounts: { "2026-10-01": 12 },
    });
    expect(highlightCards(thin)).toEqual([]);
  });

  it("가장 뜨거웠던 날·사람을 견주는 카드는 만들지 않는다", () => {
    expect(highlightCards(room).map((c) => c.key)).not.toEqual(expect.arrayContaining(["busiest", "initiations", "laugh", "question", "photo"]));
  });
});
