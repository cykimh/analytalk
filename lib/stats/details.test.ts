import { describe, expect, it } from "vitest";
import { type ChatStats, computeStats } from "./compute";
import { DETAIL_RULES, habitTable, unansweredRows, wordRows } from "./details";

const stats = (over: Partial<ChatStats>): ChatStats => ({ ...computeStats([]), ...over });
const HOUR = 3_600_000;
const habits = (o: Partial<Record<string, number>>) => ({ exclaim: 0, question: 0, tilde: 0, ellipsis: 0, emoji: 0, jamo: 0, english: 0, link: 0, ...o });

describe("숫자 부록(v2.9): 읽씹 리포트·대화 버릇·자주 쓰는 단어", () => {
  it("기준값을 상수로 고정한다", () => {
    expect(DETAIL_RULES).toEqual({ maxPeople: 6, habitPeople: 4, minHabitTexts: 10, minTurns: 5 });
  });

  it("읽씹 리포트: 메시지 많은 순 6명까지, 차례가 5번 이상인 사람만. 비율·가장 오래 기다림·연속 최대", () => {
    const s = stats({
      byPerson: { 민지: 300, 철수: 200, 영희: 100 },
      unanswered: {
        민지: { turns: 50, ignored: 4, maxWaitMs: 2 * 24 * HOUR + 3 * HOUR, maxStreak: 2 },
        철수: { turns: 40, ignored: 10, maxWaitMs: 9 * HOUR, maxStreak: 4 },
        영희: { turns: 4, ignored: 4, maxWaitMs: null, maxStreak: 4 },
      },
    });
    expect(unansweredRows(s)).toEqual([
      { name: "민지", turns: 50, ignored: 4, rate: "8%", maxWait: "2일 3시간", maxStreak: 2 },
      { name: "철수", turns: 40, ignored: 10, rate: "25%", maxWait: "9시간", maxStreak: 4 },
    ]);
    expect(unansweredRows(computeStats([]))).toEqual([]);
    expect(unansweredRows(stats({ byPerson: { 민지: 1 } }))).toEqual([]);
  });

  it("대화 버릇: 메시지 많은 4명까지 글 메시지 대비 비율(%), 줄마다 1위 표시. 아무도 안 쓴 버릇 줄은 뺀다", () => {
    const s = stats({
      byPerson: { 민지: 300, 철수: 200, 영희: 100, 지훈: 90, 수아: 80 },
      habits: {
        민지: habits({ exclaim: 30, question: 10 }),
        철수: habits({ exclaim: 5, question: 20, jamo: 8 }),
        영희: habits({ tilde: 2 }),
        지훈: habits({}),
        수아: habits({ link: 50 }),
      },
      style: {
        민지: { texts: 100, chars: 1, long: 0, short: 0 },
        철수: { texts: 40, chars: 1, long: 0, short: 0 },
        영희: { texts: 9, chars: 1, long: 0, short: 0 },
        지훈: { texts: 20, chars: 1, long: 0, short: 0 },
        수아: { texts: 60, chars: 1, long: 0, short: 0 },
      },
    });
    const t = habitTable(s);
    // 영희는 글 메시지가 10개 미만이라 빠지고, 그다음 순서로 4명을 채운다
    expect(t.people).toEqual(["민지", "철수", "지훈", "수아"]);
    expect(t.rows.map((r) => [r.key, r.label, r.values, r.top])).toEqual([
      ["exclaim", "느낌표 !", ["30%", "13%", "0%", "0%"], 0],
      ["question", "물음표 ?", ["10%", "50%", "0%", "0%"], 1],
      ["jamo", "자음 축약 ㅇㅇ", ["0%", "20%", "0%", "0%"], 1],
      ["link", "링크", ["0%", "0%", "0%", "83%"], 3],
    ]);
    expect(habitTable(computeStats([]))).toEqual({ people: [], rows: [] });
  });

  it("자주 쓰는 단어: 메시지 많은 순 6명까지, 단어가 있는 사람만", () => {
    const s = stats({
      byPerson: { 민지: 300, 철수: 200, 영희: 100 },
      topWords: { 민지: [["치킨", 30], ["피자", 2]], 철수: [], 영희: [["netflix", 4]] },
    });
    expect(wordRows(s)).toEqual([
      { name: "민지", words: [["치킨", 30], ["피자", 2]] },
      { name: "영희", words: [["netflix", 4]] },
    ]);
    expect(wordRows(computeStats([]))).toEqual([]);
  });
});
