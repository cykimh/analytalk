import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/lib/parse/parse";
import { computeStats } from "./compute";
import { findCrossedPatterns } from "./crossed";
import { resolveStat, STAT_PATHS } from "./paths";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** KST 2026-10-01 00:00 */
const T0 = Date.UTC(2026, 9, 1) - 9 * HOUR;

let seq = 0;
function msg(sender: string | null, ts: number, text = "안녕", kind: ChatMessage["kind"] = "text"): ChatMessage {
  return { id: seq++, ts, sender, kind, text, line: seq };
}

describe("computeStats", () => {
  it("6시간 공백 뒤 첫 메시지는 initiation, 직전 메시지는 closing", () => {
    const s = computeStats([
      msg("철수", T0 + 10 * HOUR),
      msg("민지", T0 + 10 * HOUR + MIN),
      msg("철수", T0 + 10 * HOUR + 2 * MIN),
      msg("민지", T0 + 20 * HOUR),
    ]);
    expect(s.initiations.민지).toBe(1);
    expect(s.closings.철수).toBe(1);
    expect(s.initiations.철수 ?? 0).toBe(0);
  });

  it("답장 간격 [2분, 4분, 10분]의 중앙값은 4분", () => {
    const s = computeStats([
      msg("철수", T0 + 10 * HOUR),
      msg("민지", T0 + 10 * HOUR + 2 * MIN),
      msg("철수", T0 + 10 * HOUR + 6 * MIN),
      msg("민지", T0 + 10 * HOUR + 10 * MIN),
      msg("철수", T0 + 10 * HOUR + 12 * MIN), // 철수가 민지에게 2분
    ]);
    // 민지 답장: 2분, 4분 / 철수 답장: 4분, 2분
    expect(s.replyMedianMs.민지).toBe(3 * MIN);
    const t = computeStats([
      msg("철수", T0 + 10 * HOUR),
      msg("민지", T0 + 10 * HOUR + 2 * MIN),
      msg("철수", T0 + 10 * HOUR + 3 * MIN),
      msg("민지", T0 + 10 * HOUR + 7 * MIN),
      msg("철수", T0 + 10 * HOUR + 8 * MIN),
      msg("민지", T0 + 10 * HOUR + 18 * MIN),
    ]);
    expect(t.replyMedianMs.민지).toBe(4 * MIN);
    expect(t.replyP75Ms.민지).toBe(7 * MIN);
  });

  it("6시간 넘는 간격은 답장으로 치지 않고 replyReceivedRate에 반영", () => {
    const s = computeStats([
      msg("철수", T0 + 10 * HOUR),
      msg("민지", T0 + 10 * HOUR + MIN),
      msg("철수", T0 + 20 * HOUR), // 19시간 뒤: 답장 아님
    ]);
    expect(s.replyMedianMs.철수).toBeNull();
    expect(s.replyReceivedRate.철수).toBe(0.5); // 첫 메시지는 답을 받았고 마지막은 못 받음
    expect(s.replyReceivedRate.민지).toBe(0);
  });

  it("22시와 3시 메시지 2개 / 전체 4개 → nightRatio 0.5", () => {
    const s = computeStats([
      msg("철수", T0 + 22 * HOUR),
      msg("민지", T0 + DAY + 3 * HOUR),
      msg("철수", T0 + DAY + 12 * HOUR),
      msg("민지", T0 + DAY + 15 * HOUR),
    ]);
    expect(s.nightRatio).toBe(0.5);
    expect(s.hourHistogram[22]).toBe(1);
    expect(s.hourHistogram[3]).toBe(1);
    expect(s.hourHistogram).toHaveLength(24);
    expect(s.weekdayHistogram).toHaveLength(7);
  });

  it("3일 연속 + 하루 쉼 + 2일 → longestStreakDays 3", () => {
    const days = [0, 1, 2, 4, 5];
    const s = computeStats(days.map((d) => msg("철수", T0 + d * DAY + 12 * HOUR)));
    expect(s.longestStreakDays).toBe(3);
    expect(s.dailyCounts["2026-10-01"]).toBe(1);
    expect(s.busiestDay).toEqual({ date: "2026-10-01", count: 1 });
  });

  it("URL 2개가 든 메시지 → media.link 2, 사진·이모티콘 종류별 집계", () => {
    const s = computeStats([
      msg("민지", T0 + 10 * HOUR, "보자 https://a.com/x 그리고 http://b.kr"),
      msg("민지", T0 + 10 * HOUR + MIN, "사진", "photo"),
      msg("민지", T0 + 10 * HOUR + 2 * MIN, "이모티콘", "emoticon"),
    ]);
    expect(s.media.민지).toEqual({ photo: 1, emoticon: 1, link: 2 });
  });

  it("시스템 메시지는 제외", () => {
    const s = computeStats([
      msg(null, T0, "철수님이 들어왔습니다.", "system"),
      msg("철수", T0 + HOUR),
    ]);
    expect(s.total).toBe(1);
    expect(s.byPerson).toEqual({ 철수: 1 });
    expect(s.share).toEqual({ 철수: 1 });
  });

  it("질문 비율, 웃음 길이, 호칭", () => {
    const s = computeStats([
      msg("민지", T0 + HOUR, "뭐해?"),
      msg("민지", T0 + HOUR + MIN, "ㅋㅋㅋ 오빠 ㅋㅋ"),
      msg("철수", T0 + HOUR + 2 * MIN, "형태 변경"),
    ]);
    expect(s.questionRate.민지).toBe(0.5);
    expect(s.laughLength.민지[3]).toBe(1);
    expect(s.laughLength.민지[2]).toBe(1);
    expect(s.addressTerms.민지.오빠).toBe(1);
    expect(s.addressTerms.철수?.형 ?? 0).toBe(0);
  });

  it("호칭은 구간당 한 번만 센다 (자기야가 자기로 중복되지 않음)", () => {
    const s = computeStats([
      msg("민지", T0 + HOUR, "자기야 뭐해 자기 ㅋ"),
      msg("민지", T0 + HOUR + MIN, "형님 오빠가 형이랑"),
    ]);
    expect(s.addressTerms.민지).toEqual({ 자기야: 1, 자기: 1, 형님: 1, 오빠: 1, 형: 1 });
  });

  it("월별 통계 키는 YYYY-MM", () => {
    const s = computeStats([
      msg("철수", T0 + 10 * HOUR, "abc"),
      msg("민지", T0 + 10 * HOUR + MIN, "abcd?"),
    ]);
    expect(Object.keys(s.monthly)).toEqual(["2026-10"]);
    expect(s.monthly["2026-10"].count).toEqual({ 철수: 1, 민지: 1 });
    expect(s.monthly["2026-10"].avgLen.민지).toBe(5);
    expect(s.monthly["2026-10"].replyMedianMs.민지).toBe(MIN);
    expect(s.monthly["2026-10"].replyMedianMs.철수).toBeNull();
  });

  it("메시지 0개여도 throw 없이 0/null", () => {
    const s = computeStats([]);
    expect(s.total).toBe(0);
    expect(s.nightRatio).toBe(0);
    expect(s.longestStreakDays).toBe(0);
    expect(s.busiestDay).toBeNull();
    expect(s.crossed).toEqual([]);
    expect(s.hourHistogram.every((n) => n === 0)).toBe(true);
  });
});

function month(p: { median: number | null; q: number; len: number; count: number }) {
  return {
    count: { 민지: p.count },
    replyMedianMs: { 민지: p.median },
    replyP75Ms: { 민지: p.median },
    questionRate: { 민지: p.q },
    avgLen: { 민지: p.len },
  };
}

describe("findCrossedPatterns", () => {
  it("답장이 빨라지고(속도 +) 질문 비율이 내려간 달을 찾는다", () => {
    const r = findCrossedPatterns({
      "2026-09": month({ median: 10 * MIN, q: 0.3, len: 10, count: 100 }),
      "2026-10": month({ median: 5 * MIN, q: 0.2, len: 10, count: 100 }),
    });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ month: "2026-10", person: "민지", up: "replySpeed", down: "questionRate" });
    expect(r[0].upPct).toBeCloseTo(100);
    expect(r[0].downPct).toBeCloseTo(-33.3, 1);
  });

  it("두 지표가 같은 방향이면 반환하지 않는다", () => {
    const r = findCrossedPatterns({
      "2026-09": month({ median: 10 * MIN, q: 0.3, len: 10, count: 100 }),
      "2026-10": month({ median: 5 * MIN, q: 0.4, len: 10, count: 100 }),
    });
    expect(r).toEqual([]);
  });

  it("전월 값이 0이거나 null이면 건너뛰고, 바로 앞 달이 아니면 비교하지 않는다", () => {
    expect(
      findCrossedPatterns({
        "2026-09": month({ median: null, q: 0, len: 10, count: 100 }),
        "2026-10": month({ median: 5 * MIN, q: 0.2, len: 10, count: 100 }),
      }),
    ).toEqual([]);
    expect(
      findCrossedPatterns({
        "2026-08": month({ median: 10 * MIN, q: 0.3, len: 10, count: 100 }),
        "2026-10": month({ median: 5 * MIN, q: 0.2, len: 10, count: 100 }),
      }),
    ).toEqual([]);
  });

  it("20% 미만 변화는 무시한다", () => {
    expect(
      findCrossedPatterns({
        "2026-09": month({ median: 10 * MIN, q: 0.3, len: 10, count: 100 }),
        "2026-10": month({ median: 9 * MIN, q: 0.29, len: 10, count: 100 }),
      }),
    ).toEqual([]);
  });
});

describe("resolveStat", () => {
  const s = computeStats([
    msg("철수", T0 + 10 * HOUR),
    msg("민지", T0 + 10 * HOUR + 2 * MIN),
  ]);
  it("월별 경로는 ms 값을 돌려준다", () => {
    expect(resolveStat("monthly.2026-10.replyMedianMs.민지", s)).toEqual({ value: 2 * MIN, unit: "ms" });
  });
  it("최상위 경로와 단위", () => {
    expect(resolveStat("replyMedianMs.민지", s)).toEqual({ value: 2 * MIN, unit: "ms" });
    expect(resolveStat("nightRatio", s)).toEqual({ value: 0, unit: "ratio" });
    expect(resolveStat("longestStreakDays", s)).toEqual({ value: 1, unit: "days" });
    expect(resolveStat("byPerson.철수", s)).toEqual({ value: 1, unit: "count" });
  });
  it("없는 경로나 null 값은 null", () => {
    expect(resolveStat("monthly.2026-11.replyMedianMs.민지", s)).toBeNull();
    expect(resolveStat("replyMedianMs.철수", s)).toBeNull();
    expect(resolveStat("nope.민지", s)).toBeNull();
    expect(resolveStat("", s)).toBeNull();
  });
  it("STAT_PATHS는 자리표시자 경로를 담는다", () => {
    expect(STAT_PATHS).toContain("replyMedianMs.<이름>");
    expect(STAT_PATHS).toContain("monthly.<YYYY-MM>.replyMedianMs.<이름>");
    expect(STAT_PATHS).toContain("nightRatio");
  });
});
