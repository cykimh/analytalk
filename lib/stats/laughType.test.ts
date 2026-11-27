import { describe, expect, it } from "vitest";
import { LAUGH_TYPE_LABEL, LAUGH_TYPE_RULES, laughType } from "./laughType";

/** ㅋ 길이 히스토그램(인덱스 = 길이 1~10, 10은 10 이상). runs는 [길이, 횟수] */
const hist = (...runs: [number, number][]) => {
  const h = new Array<number>(11).fill(0);
  for (const [len, n] of runs) h[len] += n;
  return h;
};

describe("laughType (v2.8 멤버별 ㅋ 유형)", () => {
  it("기준값을 상수로 고정한다", () => {
    expect(LAUGH_TYPE_RULES).toEqual({ minMessages: 20, deadpanRate: 0.05, maniacShare: 0.25 });
    expect(LAUGH_TYPE_LABEL).toEqual({ deadpan: "무표정형", restrained: "절제형", classic: "정석형", burst: "폭발형", maniac: "광기형" });
  });

  it("메시지가 20개 미만이면 데이터가 모자라 유형이 없다", () => {
    expect(laughType(hist([3, 10]), 19)).toBeNull();
    expect(laughType(hist([3, 10]), 20)).toBe("classic");
  });

  it("웃음이 메시지 20개에 1번 꼴(5%) 미만이면 무표정형. 히스토그램이 없어도 무표정형", () => {
    expect(laughType(hist([2, 4]), 100)).toBe("deadpan");
    expect(laughType(hist([2, 5]), 100)).toBe("restrained");
    expect(laughType(undefined, 100)).toBe("deadpan");
    expect(laughType(hist(), 30)).toBe("deadpan");
  });

  it("가운데 길이(중앙값)로 고른다: 1~2 절제형, 3~4 정석형, 5~9 폭발형, 10 이상 광기형", () => {
    expect(laughType(hist([1, 3], [2, 5], [6, 2]), 50)).toBe("restrained");
    expect(laughType(hist([2, 3], [3, 4], [4, 1]), 50)).toBe("classic");
    expect(laughType(hist([4, 3], [5, 3], [9, 2]), 50)).toBe("burst");
    expect(laughType(hist([9, 1], [10, 2]), 50)).toBe("maniac");
  });

  it("중앙값은 아래쪽 가운데 값이다(짝수 개면 작은 쪽)", () => {
    // 길이 2가 2번, 길이 5가 2번 → 아래쪽 가운데는 2
    expect(laughType(hist([2, 2], [5, 2]), 40)).toBe("restrained");
  });

  it("10 이상이 웃음의 25% 이상이면 중앙값과 상관없이 광기형", () => {
    expect(laughType(hist([3, 6], [10, 2]), 50)).toBe("maniac");
    expect(laughType(hist([3, 7], [10, 2]), 50)).toBe("classic");
  });
});
