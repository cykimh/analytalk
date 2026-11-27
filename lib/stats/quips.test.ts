import { describe, expect, it } from "vitest";
import { hourLabel, messageQuip, nightQuip, peakHour, peakQuip, QUIPS, replyQuip } from "./quips";

const MIN = 60_000;

describe("숫자 카드 재치 한 줄(v2.9): 구간마다 고정 문구", () => {
  it("문구 표를 상수로 고정한다(구간 끝은 다음 구간 미만)", () => {
    expect(QUIPS.messages.map(([upTo]) => upTo)).toEqual([100, 1_000, 10_000, 50_000, Infinity]);
    expect(QUIPS.replyMs.map(([upTo]) => upTo)).toEqual([MIN, 5 * MIN, 30 * MIN, 180 * MIN, Infinity]);
    expect(QUIPS.night.map(([upTo]) => upTo)).toEqual([0.05, 0.2, 0.4, Infinity]);
    for (const table of Object.values(QUIPS)) for (const [, text] of table) expect(text.length).toBeLessThanOrEqual(20);
  });

  it("메시지 수", () => {
    expect([0, 99, 100, 999, 1_000, 9_999, 10_000, 49_999, 50_000].map(messageQuip)).toEqual([
      "이제 막 첫 장을 넘긴 사이",
      "이제 막 첫 장을 넘긴 사이",
      "수첩 한 권은 채운 분량",
      "수첩 한 권은 채운 분량",
      "단편집 한 권은 나올 분량",
      "단편집 한 권은 나올 분량",
      "장편 연재도 거뜬한 분량",
      "장편 연재도 거뜬한 분량",
      "대하소설 전집 급 기록",
    ]);
  });

  it("답장 중앙값(1분 이하면 거의 실시간). 값이 없으면 null", () => {
    expect([30_000, MIN, MIN + 1, 5 * MIN, 30 * MIN, 3 * 60 * MIN, 3 * 60 * MIN + 1].map(replyQuip)).toEqual([
      "거의 실시간",
      "거의 실시간",
      "라면 물 끓기 전에 온다",
      "라면 물 끓기 전에 온다",
      "한숨 돌리고 답하는 편",
      "바빠도 꼬박꼬박",
      "답장은 내일의 나에게",
    ]);
    expect(replyQuip(null)).toBeNull();
  });

  it("밤 비율", () => {
    expect([0, 0.049, 0.05, 0.199, 0.2, 0.39, 0.4, 0.9].map(nightQuip)).toEqual([
      "다들 일찍 자는 모범생",
      "다들 일찍 자는 모범생",
      "가끔 밤이 길어진다",
      "가끔 밤이 길어진다",
      "해 지면 살아나는 방",
      "해 지면 살아나는 방",
      "밤이 본업인 방",
      "밤이 본업인 방",
    ]);
  });

  it("가장 많이 보낸 시각(동률은 이른 시각)과 그 이름·문구", () => {
    const hist = new Array<number>(24).fill(0);
    hist[21] = 5;
    hist[9] = 5;
    hist[2] = 3;
    expect(peakHour(hist)).toBe(9);
    expect(peakHour(new Array<number>(24).fill(0))).toBeNull();
    expect([0, 4, 5, 11, 12, 13, 17, 18, 21, 22, 23].map(hourLabel)).toEqual([
      "새벽 12시",
      "새벽 4시",
      "오전 5시",
      "오전 11시",
      "낮 12시",
      "오후 1시",
      "오후 5시",
      "저녁 6시",
      "저녁 9시",
      "밤 10시",
      "밤 11시",
    ]);
    expect([0, 5, 9, 12, 14, 18, 22].map(peakQuip)).toEqual([
      "새벽 수다 모임",
      "해 뜨면 바로 출석",
      "오전부터 딴짓 중",
      "점심시간이 곧 수다 시간",
      "오후의 나른한 수다",
      "저녁 먹고 모이는 방",
      "자기 전 한마디가 길어진다",
    ]);
  });
});
