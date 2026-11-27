import { describe, expect, it } from "vitest";
import { matchesSpeech, normalizeQuote, originalSpan, OVERLAP_MIN, overlapRatio } from "./quoteMatch";

describe("normalizeQuote (v2.5: 따옴표 대사를 원문과 대 보기 전 정규화)", () => {
  it("공백·줄바꿈·문장부호·말줄임·물결·이모티콘 기호를 지우고 대소문자를 무시한다", () => {
    expect(normalizeQuote("영화 볼래?\n내일 저녁")).toBe("영화볼래내일저녁");
    expect(normalizeQuote("진짜…… 대박~~ 👍🏻❤️")).toBe("진짜대박");
    expect(normalizeQuote("OK, Good!")).toBe("okgood");
    expect(normalizeQuote("[사진] ⏎ 봐 봐")).toBe("사진봐봐");
  });

  it("ㅋ·ㅎ·ㅠ·ㅜ 같은 자모 반복은 한 글자로, !·?는 문장부호라 지운다", () => {
    expect(normalizeQuote("ㅋㅋㅋㅋㅋ 진짜??!!")).toBe("ㅋ진짜");
    expect(normalizeQuote("ㅠㅠㅠ 미안 ㅎㅎ")).toBe("ㅠ미안ㅎ");
    // 다른 자모는 합치지 않고, 같은 음절 반복도 그대로 둔다
    expect(normalizeQuote("ㅋㅎㅋㅎ 하하하")).toBe("ㅋㅎㅋㅎ하하하");
  });

  it("문장부호·이모티콘뿐이면 빈 글", () => {
    expect(normalizeQuote("?!… 😂")).toBe("");
  });
});

describe("originalSpan: 정규화한 quote가 든 원문 구간(근거 카드에 실제 메시지 글자로 넣는다)", () => {
  it("띄어쓰기·문장부호가 달라도 원문의 그 구간을 돌려준다", () => {
    expect(originalSpan("집에서 쉬는 중 ㅋㅋ", normalizeQuote("쉬는중"))).toBe("쉬는 중");
    expect(originalSpan("영화 볼래?\n내일 저녁", normalizeQuote("볼래 내일"))).toBe("볼래?\n내일");
  });

  it("합친 자모 반복은 원문의 반복 전체까지 넣는다", () => {
    expect(originalSpan("진짜?? ㅋㅋㅋㅋ 대박", normalizeQuote("진짜 ㅋ"))).toBe("진짜?? ㅋㅋㅋㅋ");
  });

  it("없으면 null, 빈 quote도 null", () => {
    expect(originalSpan("집에서 쉬는 중", normalizeQuote("학교에서"))).toBeNull();
    expect(originalSpan("집에서 쉬는 중", "")).toBeNull();
  });
});

describe("overlapRatio: quote 글자 중 메시지(같은 길이 구간)에 있는 비율", () => {
  it("한 글자만 다르면 높고, 다른 말이면 낮다", () => {
    expect(overlapRatio(normalizeQuote("오늘 저녁 뭐 먹을래"), normalizeQuote("오늘 저녁 뭐 먹을래?"))).toBe(1);
    expect(overlapRatio(normalizeQuote("오늘 저녁 뭐 먹을까"), normalizeQuote("오늘 저녁 뭐 먹을래"))).toBeGreaterThanOrEqual(OVERLAP_MIN);
    expect(overlapRatio(normalizeQuote("나는 철수가 제일 좋아"), normalizeQuote("오늘 저녁 뭐 먹을래"))).toBeLessThan(OVERLAP_MIN);
  });

  it("긴 메시지 안의 비슷한 구간도 찾는다. quote가 메시지보다 길면 모자란 만큼 낮다", () => {
    expect(overlapRatio(normalizeQuote("내일 저녁에 영화 보자"), normalizeQuote("그럼 내일 저녁엔 영화 보자 어때"))).toBeGreaterThanOrEqual(OVERLAP_MIN);
    expect(overlapRatio(normalizeQuote("집에서 쉬는 중인데 너는 뭐해"), normalizeQuote("쉬는 중"))).toBeLessThan(OVERLAP_MIN);
    expect(OVERLAP_MIN).toBe(0.8);
  });
});

describe("matchesSpeech: 한 사람이 보낸 메시지(정규화본, 보낸 순서)에 맞는 말인가", () => {
  const sent = ["오늘 뭐해?", "집에서 쉬는 중 ㅋㅋ", "영화 볼래?", "내일 저녁", "좋아!", "그럼 내일 7시에 극장 앞에서 보자"].map(normalizeQuote);

  it("메시지 하나의 부분 문자열(띄어쓰기·ㅋ 개수·문장부호가 달라도)", () => {
    expect(matchesSpeech(normalizeQuote("집에서 쉬는중ㅋㅋㅋㅋ"), sent)).toBe(true);
    expect(matchesSpeech(normalizeQuote("좋아"), sent)).toBe(true);
  });

  it("연속한 두세 메시지를 이어 붙인 것", () => {
    expect(matchesSpeech(normalizeQuote("영화 볼래? 내일 저녁"), sent)).toBe(true);
    expect(matchesSpeech(normalizeQuote("영화 볼래 내일 저녁 좋아"), sent)).toBe(true);
    // 네 메시지에 걸치면 이어 붙인 것으로 보지 않는다
    expect(matchesSpeech(normalizeQuote("영화 볼래 내일 저녁 좋아 그럼"), sent)).toBe(false);
  });

  it("글자 겹침 80% 이상", () => {
    expect(matchesSpeech(normalizeQuote("그럼 내일 7시에 극장 앞에서 봐"), sent)).toBe(true);
    expect(matchesSpeech(normalizeQuote("나는 철수가 제일 좋아"), sent)).toBe(false);
  });

  it("빈 quote는 맞는 것으로 본다(문장부호·이모티콘뿐인 따옴표)", () => {
    expect(matchesSpeech("", sent)).toBe(true);
    expect(matchesSpeech(normalizeQuote("아무 말"), [])).toBe(false);
  });
});
