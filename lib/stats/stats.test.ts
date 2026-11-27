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

  it("v2.8 laughChars: 글 메시지의 ㅋ 글자 수(길이 상한 없음, ㅎ·사진은 세지 않음). 글을 보낸 사람은 0이어도 키가 있다", () => {
    const s = computeStats([
      msg("민지", T0 + HOUR, `${"ㅋ".repeat(14)} 미쳤다 ㅋㅋ`),
      msg("민지", T0 + HOUR + MIN, "ㅎㅎㅎ"),
      msg("철수", T0 + HOUR + 2 * MIN, "응"),
      msg("철수", T0 + HOUR + 3 * MIN, "", "photo"),
      msg("영희", T0 + HOUR + 4 * MIN, "", "photo"),
    ]);
    expect(s.laughChars).toEqual({ 민지: 16, 철수: 0 });
    // laughLength는 그대로 10 이상을 한 칸에 모은다
    expect(s.laughLength.민지[10]).toBe(1);
  });

  describe("v2.9 화면 전용 통계", () => {
    it("nightByPerson: 사람마다 밤(22시~5시 전) 메시지 수(사진 포함). 밤에 안 보낸 사람은 0", () => {
      const s = computeStats([
        msg("민지", T0 + 23 * HOUR, "자?"),
        msg("민지", T0 + 26 * HOUR, "", "photo"),
        msg("철수", T0 + 12 * HOUR, "점심"),
        msg("철수", T0 + 29 * HOUR, "아침"),
      ]);
      expect(s.nightByPerson).toEqual({ 민지: 2, 철수: 0 });
    });

    it("style: 글 메시지 수·글자 수(코드 포인트)·50자 이상·5자 이하", () => {
      const s = computeStats([
        msg("민지", T0 + HOUR, "가".repeat(50)),
        msg("민지", T0 + HOUR + MIN, "응"),
        msg("민지", T0 + HOUR + 2 * MIN, "😂😂😂😂😂"),
        msg("민지", T0 + HOUR + 3 * MIN, "보통 길이의 메시지"),
        msg("민지", T0 + HOUR + 4 * MIN, "", "photo"),
      ]);
      expect(s.style?.민지).toEqual({ texts: 4, chars: 50 + 1 + 5 + 10, long: 1, short: 2 });
    });

    it("habits: 버릇이 든 글 메시지 수(감탄·질문·물결·말줄임·이모지·자음 축약·영어·링크). ㅋ·ㅎ만인 자음은 축약이 아니다", () => {
      const s = computeStats([
        msg("민지", T0 + HOUR, "진짜?! 대박~~ 😂"),
        msg("민지", T0 + HOUR + MIN, "음... 그래…"),
        msg("민지", T0 + HOUR + 2 * MIN, "ㅇㅇ ㄱㄱ"),
        msg("민지", T0 + HOUR + 3 * MIN, "ㅋㅋㅋ ㅎㅎ"),
        msg("민지", T0 + HOUR + 4 * MIN, "OK 이거 봐 https://example.com/a.b..c"),
        msg("민지", T0 + HOUR + 5 * MIN, "a 한 글자 영어는 빼고 ㅇ도 빼"),
      ]);
      expect(s.habits?.민지).toEqual({ exclaim: 1, question: 1, tilde: 1, ellipsis: 1, emoji: 1, jamo: 1, english: 1, link: 1 });
    });

    it("replyMedianAll: 방 전체 답장 간격(6시간 안, 발신자가 바뀔 때)의 중앙값. 답장이 없으면 null", () => {
      const s = computeStats([
        msg("철수", T0 + 10 * HOUR),
        msg("민지", T0 + 10 * HOUR + 2 * MIN),
        msg("철수", T0 + 10 * HOUR + 6 * MIN),
        msg("영희", T0 + 10 * HOUR + 16 * MIN),
      ]);
      expect(s.replyMedianAll).toBe(4 * MIN);
      expect(computeStats([msg("철수", T0)]).replyMedianAll).toBeNull();
    });

    it("unanswered(읽씹): 차례(6시간 안에 이어 보낸 같은 사람의 메시지들)마다 6시간 안에 다른 사람이 답했는지. 마지막 차례는 세지 않는다", () => {
      const s = computeStats([
        // 민지 차례 1(두 메시지): 철수가 3분 뒤 답 → 답 받음
        msg("민지", T0),
        msg("민지", T0 + MIN),
        msg("철수", T0 + 4 * MIN),
        // 철수 차례: 7시간 동안 아무도 → 읽씹. 그 뒤 철수가 또(새 차례) → 또 읽씹(9시간 뒤 민지)
        msg("철수", T0 + 7 * HOUR + 4 * MIN),
        msg("민지", T0 + 16 * HOUR + 4 * MIN),
        // 민지 차례 3: 마지막이라 세지 않는다
        msg("민지", T0 + 16 * HOUR + 5 * MIN),
      ]);
      expect(s.unanswered).toEqual({
        // 민지: 차례 1은 답 받음(3분), 차례 2(16:04~16:05)는 마지막이라 빠진다
        민지: { turns: 1, ignored: 0, maxWaitMs: 3 * MIN, maxStreak: 0 },
        // 철수: 0:04 차례는 7시간 뒤 자기 메시지가 다음 → 읽씹(기다림은 민지가 답한 16:04까지 16시간), 7:04 차례도 9시간 → 읽씹. 연속 2번
        철수: { turns: 2, ignored: 2, maxWaitMs: 16 * HOUR, maxStreak: 2 },
      });
    });

    it("topWords: 사람마다 두 번 이상 쓴 두 글자 이상 한글·영어 단어 TOP 10(많은 순, 같으면 가나다). 조사는 떼고 불용어·ㅋ·숫자·링크·이메일은 뺀다", () => {
      const rows = [
        "치킨 먹자",
        "치킨은 진짜 맛있어",
        "치킨을 시켜",
        "피자 피자",
        "Netflix 보자 netflix",
        "https://example.com/chicken chicken@example.com 010-1234-5678",
        "ㅋㅋㅋ 그냥 그냥 근데 근데",
        "철수 철수야 철수는",
        "7시에 만나 7시에 3pm 3pm",
      ];
      const s = computeStats(rows.map((text, i) => msg("민지", T0 + i * MIN, text)));
      expect(s.topWords?.민지).toEqual([
        ["철수", 3],
        ["치킨", 3],
        ["netflix", 2],
        ["피자", 2],
      ]);
      // 많아야 10개
      const many = Array.from({ length: 12 }, (_, i) => `단어${String.fromCharCode(0xac00 + i)} 단어${String.fromCharCode(0xac00 + i)}`);
      expect(computeStats(many.map((text, i) => msg("철수", T0 + i * MIN, text))).topWords?.철수).toHaveLength(10);
    });

    it("topWords: hiddenNames(뺀 멤버·봇의 원래 이름)는 누구의 단어 목록에도 없다. 넣은 멤버 이름은 남는다", () => {
      const rows: [string, string][] = [
        ["철수", "영희야 영희는 김영희 어디 갔어"],
        ["철수", "영희한테 물어봐 영희 영희랑 민지"],
        ["민지", "영희가 그랬어? 영희 진짜 영희 영희야"],
        ["민지", "철수야 철수 철수는 오픈채팅봇 오픈채팅봇"],
      ];
      const messages = rows.map(([sender, text], i) => msg(sender, T0 + i * MIN, text));
      const s = computeStats(messages, { hiddenNames: ["김영희", "오픈채팅봇"] });
      const all = Object.values(s.topWords ?? {}).flat().map(([w]) => w);
      for (const w of all) expect(w).not.toMatch(/영희|오픈채팅봇/);
      expect(s.topWords?.민지?.map(([w]) => w)).toContain("철수");
      expect(s.topWords?.철수).toEqual([]);
      // 거르지 않으면 영희가 들어간다(전제)
      expect(computeStats(messages).topWords?.철수?.map(([w]) => w)).toContain("영희");
    });
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

describe("엇갈린 패턴의 표본 하한 (D11)", () => {
  it("한 사람-달 메시지가 적으면(1 → 2개) 비교하지 않는다", () => {
    expect(
      findCrossedPatterns({
        "2026-09": month({ median: 10 * MIN, q: 0.5, len: 30, count: 1 }),
        "2026-10": month({ median: 5 * MIN, q: 0.1, len: 2, count: 2 }),
      }),
    ).toEqual([]);
  });

  it("답장 간격 표본이 적으면 답장 속도는 비교하지 않는다(다른 지표는 본다)", () => {
    const monthly = {
      "2026-09": month({ median: 10 * MIN, q: 0.3, len: 10, count: 100 }),
      "2026-10": month({ median: 2 * MIN, q: 0.2, len: 10, count: 100 }),
    };
    const replies = { "2026-09": { 민지: 2 }, "2026-10": { 민지: 50 } };
    expect(findCrossedPatterns(monthly, { replies })).toEqual([]);
    expect(findCrossedPatterns(monthly, { replies: { "2026-09": { 민지: 50 }, "2026-10": { 민지: 50 } } })).toHaveLength(1);
  });

  it("텍스트가 없는 달(사진만 보냄)은 질문 비율·평균 길이가 null이라 -100%가 나오지 않는다", () => {
    const s = computeStats([msg("민지", T0 + HOUR, "사진", "photo"), msg("철수", T0 + HOUR + MIN, "응")]);
    expect(s.monthly["2026-10"].questionRate.민지).toBeNull();
    expect(s.monthly["2026-10"].avgLen.민지).toBeNull();
    expect(s.monthly["2026-10"].avgLen.철수).toBe(1);
  });

  it("앞뒤가 잘린 달(대화가 그달 며칠만 덮음)은 비교하지 않는다: 9월 30일 내내 + 10월 1일 하루", () => {
    const sept = Date.UTC(2026, 8, 1) - 9 * HOUR;
    const msgs: ChatMessage[] = [];
    for (let d = 0; d < 30; d++) {
      for (let k = 0; k < 4; k++) {
        msgs.push(msg("철수", sept + d * DAY + 20 * HOUR + k * 10 * MIN, "뭐해?"), msg("민지", sept + d * DAY + 20 * HOUR + k * 10 * MIN + 2 * MIN, "쉬는 중"));
      }
    }
    // 10월 1일 하루: 답장이 느리고 메시지가 적다
    for (let k = 0; k < 3; k++) {
      msgs.push(msg("철수", T0 + 20 * HOUR + k * 60 * MIN, "뭐해 오늘은 바빠?"), msg("민지", T0 + 20 * HOUR + k * 60 * MIN + 40 * MIN, "응"));
    }
    const s = computeStats(msgs);
    expect(s.crossed.filter((c) => c.month === "2026-10")).toEqual([]);
  });

  it("다 덮은 달끼리는 하루 평균 메시지 수로 비교한다(31일 달과 30일 달의 차이는 패턴이 아니다)", () => {
    const monthly = {
      "2026-09": month({ median: 10 * MIN, q: 0.3, len: 10, count: 300 }),
      "2026-10": month({ median: 10 * MIN, q: 0.3, len: 10, count: 310 }),
    };
    expect(findCrossedPatterns(monthly, { coveredDays: { "2026-09": 30, "2026-10": 31 } })).toEqual([]);
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
