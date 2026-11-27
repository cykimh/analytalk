import { describe, expect, it } from "vitest";
import { hiddenWordFilter, wordsOf } from "./words";

describe("자주 쓰는 단어에서 뺀 멤버·봇 이름 거르기(v2.9)", () => {
  const drop = hiddenWordFilter(["김민지", "AI봇", "Tom"], ["철수", "영희"])!;
  const words = (text: string) => wordsOf(text, drop);

  it("원래 이름·성을 뺀 이름과 그 뒤에 조사·호칭이 붙은 꼴(세 글자까지)을 뺀다", () => {
    expect(words("김민지 민지 민지야 민지는 민지한테 민지랑은 민지씨 김민지가")).toEqual([]);
    // 한글·영어가 섞인 이름은 단어 나누기처럼 덩어리로 나눈 꼴을 거른다(AI봇 → ai). 한 글자 덩어리(봇)는 단어가 아니다
    expect(words("ai봇 AI봇이 tom Tom이")).toEqual(["봇이"]);
  });

  it("이름과 상관없는 말·넣은 멤버 이름은 그대로 둔다", () => {
    expect(words("철수 철수야 영희는 치킨 민트 tomorrow")).toEqual(["철수", "철수", "영희", "치킨", "민트", "tomorrow"]);
    // 이름 뒤가 네 글자 넘게 이어지면 다른 낱말로 본다
    expect(words("민지네집앞카페")).toEqual(["민지네집앞카페"]);
  });

  it("넣은 멤버와 이름이 겹치면 거르지 않는다(누구를 부른 것인지 모른다). 넣은 멤버의 더 긴 이름도 지킨다", () => {
    const f = hiddenWordFilter(["김민지", "민"], ["민지", "민지수"])!;
    expect(wordsOf("민지 민지야 민지수 민지수는", f)).toEqual(["민지", "민지", "민지수", "민지수"]);
    // 한 글자 이름은 거를 꼴이 없다
    expect(wordsOf("민트 민지", hiddenWordFilter(["민"], ["철수"]) ?? undefined)).toEqual(["민트", "민지"]);
  });

  it("거를 이름이 없으면 null", () => {
    expect(hiddenWordFilter([], ["철수"])).toBeNull();
    expect(hiddenWordFilter(["(알 수 없음)", "  "], ["철수"])).not.toBeNull();
    expect(wordsOf("알 수 없음 없음은", hiddenWordFilter(["(알 수 없음)"], ["철수"])!)).toEqual([]);
  });
});
