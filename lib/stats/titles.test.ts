import { describe, expect, it } from "vitest";
import { type ChatStats, computeStats } from "./compute";
import { TITLE_RULES, titleCards } from "./titles";

const stats = (over: Partial<ChatStats>): ChatStats => ({ ...computeStats([]), ...over });
const MIN = 60_000;
const style = (texts: number, long: number) => ({ texts, chars: texts * 10, long, short: 0 });

/** 1:1(민지·철수): 칭호 여섯이 모두 나오는 통계 */
const pair = stats({
  total: 600,
  byPerson: { 민지: 320, 철수: 280 },
  initiations: { 민지: 31, 철수: 19 },
  replyMedianMs: { 민지: 1 * MIN, 철수: 12 * MIN },
  laughChars: { 민지: 5231, 철수: 840 },
  style: { 민지: style(300, 9), 철수: style(250, 30) },
  nightByPerson: { 민지: 40, 철수: 120 },
});

describe("titleCards (v2.9 '누가 더 ___' 칭호)", () => {
  it("기준값을 상수로 고정한다", () => {
    expect(TITLE_RULES).toEqual({ minInitiations: 5, minReplyMessages: 10, minLaughChars: 10, minLongTexts: 20, minNight: 5 });
  });

  it("1:1은 두 사람을 견준다: 집착왕 → 광속답장러 → 읽씹 마스터 → ㅋ 폭격기 → 장문 장인 → 새벽요정", () => {
    expect(titleCards(pair).map((t) => [t.key, t.title, t.value])).toEqual([
      ["obsessed", "집착왕", "민지 62% vs 철수 38%"],
      ["speedy", "광속답장러", "민지 1분 vs 철수 12분"],
      ["ghost", "읽씹 마스터", "철수 12분 vs 민지 1분"],
      ["laugh", "ㅋ 폭격기", "민지 5,231개 vs 철수 840개"],
      ["essay", "장문 장인", "철수 12% vs 민지 3%"],
      ["owl", "새벽요정", "철수 120개 vs 민지 40개"],
    ]);
    for (const t of titleCards(pair)) {
      expect(t.desc.length).toBeGreaterThan(0);
      expect(t.winner).toBe(t.value.split(" ")[0]);
    }
  });

  it("단톡은 방 전체 1위 한 사람(동률은 이름 순)", () => {
    const group = stats({
      total: 900,
      byPerson: { 영희: 300, 민지: 300, 철수: 300 },
      initiations: { 영희: 20, 민지: 20, 철수: 9 },
      replyMedianMs: { 영희: 3 * MIN, 민지: 2 * MIN, 철수: 30 * MIN },
      laughChars: { 영희: 30, 민지: 12, 철수: 0 },
      style: { 영희: style(100, 1), 민지: style(100, 5), 철수: style(19, 19) },
      nightByPerson: { 영희: 7, 민지: 7, 철수: 1 },
    });
    expect(titleCards(group).map((t) => [t.key, t.value])).toEqual([
      ["obsessed", "민지 · 대화 시작의 41%"],
      ["speedy", "민지 · 중앙값 2분"],
      ["ghost", "철수 · 중앙값 30분"],
      ["laugh", "영희 · ㅋ 30개"],
      ["essay", "민지 · 글의 5%"],
      ["owl", "민지 · 밤 메시지 7개"],
    ]);
  });

  it("데이터가 모자란 칭호는 뺀다: 예전 통계(필드 없음)·문턱 미달·답장 속도가 모두 같으면 광속·읽씹 둘 다 없음", () => {
    const old = stats({ total: 600, byPerson: pair.byPerson, initiations: pair.initiations, replyMedianMs: pair.replyMedianMs });
    expect(titleCards(old).map((t) => t.key)).toEqual(["obsessed", "speedy", "ghost"]);
    const thin = stats({
      total: 20,
      byPerson: { 민지: 9, 철수: 11 },
      initiations: { 민지: 2, 철수: 2 },
      replyMedianMs: { 민지: MIN, 철수: MIN },
      laughChars: { 민지: 9 },
      style: { 민지: style(9, 9), 철수: style(11, 0) },
      nightByPerson: { 민지: 4, 철수: 0 },
    });
    expect(titleCards(thin)).toEqual([]);
    const same = stats({ ...pair, replyMedianMs: { 민지: MIN, 철수: MIN } });
    expect(titleCards(same).map((t) => t.key)).not.toContain("speedy");
    expect(titleCards(same).map((t) => t.key)).not.toContain("ghost");
    expect(titleCards(computeStats([]))).toEqual([]);
  });
});
