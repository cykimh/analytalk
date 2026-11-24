import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/lib/parse/parse";
import { applyDisplayNames, checkDisplayName, findNameLeftovers, type NameMap } from "./names";

let seq = 0;
function msg(sender: string | null, text = "안녕"): ChatMessage {
  const id = seq++;
  return { id, ts: Date.UTC(2026, 9, 1) + id * 60_000, sender, kind: sender === null ? "system" : "text", text, line: id + 1 };
}

/** 성공하면 메시지를, 실패하면 이유를 돌려준다 */
function apply(msgs: ChatMessage[], map: NameMap, systemNames: string[] = [], merged?: string[][]) {
  const r = applyDisplayNames(msgs, map, systemNames, merged);
  return r.ok ? r.messages : r.reason;
}

describe("applyDisplayNames: 이름 정리 (Review Focus 5)", () => {
  const msgs = [msg("김민지"), msg("민지폰"), msg("이철수")];

  it("[같은 사람]으로 묶은 별칭은 한 표시 이름을 같이 쓴다", () => {
    const out = apply(msgs, { 김민지: "P1", 민지폰: "P1", 이철수: "P2" }, [], [["김민지", "민지폰"]]);
    expect(typeof out !== "string" && out.map((m) => m.sender)).toEqual(["P1", "P1", "P2"]);
  });

  it("묶지 않은 두 사람에게 같은 이름 → collision", () => {
    expect(apply(msgs, { 김민지: "P1", 민지폰: "P1", 이철수: "P2" })).toBe("collision");
    expect(apply(msgs, { 김민지: "P1", 민지폰: "P2", 이철수: "P1" }, [], [["김민지", "민지폰"]])).toBe("collision");
    // 시스템 문구에만 나오는 사람도 발신자와 이름이 겹치면 안 된다
    expect(apply(msgs, { 김민지: "P1", 민지폰: "P2", 이철수: "P3", 박영희: "P3" }, ["박영희"])).toBe("collision");
  });

  it("빈 이름 → empty", () => {
    expect(apply(msgs, { 김민지: "", 민지폰: "P2", 이철수: "P3" })).toBe("empty");
    expect(apply(msgs, { 김민지: "  ", 민지폰: "P2", 이철수: "P3" })).toBe("empty");
  });

  it.each(["a|b", "a.b", "{a}", "a\nb", "<b>", "가".repeat(21)])("금지 문자·21자 %j → invalid", (bad) => {
    expect(apply(msgs, { 김민지: bad, 민지폰: "P2", 이철수: "P3" })).toBe("invalid");
  });

  it("20자와 이모지 20개는 받는다", () => {
    expect(checkDisplayName("가".repeat(20))).toBeNull();
    expect(checkDisplayName("😀".repeat(20))).toBeNull();
  });

  it("발신자나 시스템 문구 속 이름의 매핑이 없으면 → unmapped", () => {
    expect(apply(msgs, { 김민지: "P1", 민지폰: "P2" })).toBe("unmapped");
    expect(apply(msgs, { 김민지: "P1", 민지폰: "P2", 이철수: "P3" }, ["박영희"])).toBe("unmapped");
  });

  it("표시 이름의 앞뒤 공백은 떼고 쓰며, 입력 메시지는 바꾸지 않는다", () => {
    const input = [msg("김민지", "김민지야")];
    const out = apply(input, { 김민지: " P1 " });
    expect(typeof out !== "string" && out[0]).toMatchObject({ sender: "P1", text: "P1야" });
    expect(input[0]).toMatchObject({ sender: "김민지", text: "김민지야" });
  });
});

describe("applyDisplayNames: 본문 속 이름", () => {
  /** map의 첫 이름이 text를 보냈을 때의 본문. map의 나머지 이름도 발신자로 넣는다 */
  const body = (text: string, map: NameMap = { 김민지: "P1" }, merged?: string[][]) => {
    const [first, ...rest] = Object.keys(map);
    const out = apply([msg(first, text), ...rest.map((n) => msg(n))], map, [], merged);
    if (typeof out === "string") throw new Error(out);
    return out[0].text;
  };

  it.each([
    ["김민지야 밥 먹자", "P1야 밥 먹자"],
    ["민지랑 갔어", "P1랑 갔어"],
    ["민지수", "민지수"],
  ])("{김민지:P1}: %s → %s", (text, expected) => {
    expect(body(text)).toBe(expected);
  });

  it("앞이 한글 음절이면 그대로(우리·울·내는 예외), 조사·공백·기호 앞뒤면 바꾼다", () => {
    expect(body("가민지 왔어")).toBe("가민지 왔어");
    expect(body("우리민지 울민지 내민지")).toBe("우리P1 울P1 내P1");
    expect(body("애기민지 아기민지 내사랑민지")).toBe("애기P1 아기P1 내사랑P1");
    expect(body("@김민지님 민지한테 줘 (민지)")).toBe("@P1님 P1한테 줘 (P1)");
    expect(body("ㅋㅋ민지는 민지씨 민지도")).toBe("ㅋㅋP1는 P1씨 P1도");
  });

  it("목록 밖의 흔한 조사·호칭(을·를·에·으로·언니 등)이 붙어도 바꾼다", () => {
    expect(body("김민지를 봤어 민지언니랑 민지네 민지에게")).toBe("P1를 봤어 P1언니랑 P1네 P1에게");
    expect(body("민지폰으로 보냄", { 김민지: "P1", 민지폰: "P1" }, [["김민지", "민지폰"]])).toBe("P1으로 보냄");
  });

  it.each([
    ["민지라고 했잖아", "P1라고 했잖아"],
    ["민지인데", "P1인데"],
    ["민지였어", "P1였어"],
    ["민지이었어", "P1이었어"],
    ["민지잖아", "P1잖아"],
    ["민지면 돼", "P1면 돼"],
    ["민지임", "P1임"],
    ["민지예요", "P1예요"],
  ])("서술격·어미가 붙어도 바꾼다: %s → %s", (text, expected) => {
    expect(body(text)).toBe(expected);
  });

  it("별명형 이름은 꼬리를 뗀 말을 바꾸고, 꼬리만 있는 말은 둔다", () => {
    const nick = { 민지공주: "P1" };
    expect(body("민지 어디야 민지공주 왔다", nick)).toBe("P1 어디야 P1 왔다");
    expect(body("공주님 오셨다", nick)).toBe("공주님 오셨다");
    expect(body("민지야 김민지 왔어", { 김민지님: "P1" })).toBe("P1야 P1 왔어");
    expect(body("민지랑 지니", { 민지짱: "P1" })).toBe("P1랑 지니");
  });

  it.each(["우리민지", "애기민지", "내사랑민지", "울애기민지", "이쁜민지", "귀요미민지", "최고민지"])(
    "앞에 별명이 붙은 4글자 이상 이름 %s: 끝 2글자(실제 이름)도 바꾼다",
    (name) => {
      expect(body("민지야 어디야", { [name]: "P1" })).toBe("P1야 어디야");
    },
  );

  it("머리말을 뗀 말도 이름으로 보고, 꼬리가 섞인 끝 2글자·흔한 별명 말은 두지 않는다", () => {
    expect(body("김민지야 민지는", { 우리김민지: "P1" })).toBe("P1야 P1는");
    expect(body("민지야 김민지 왔어", { 애기김민지공주: "P1" })).toBe("P1야 P1 왔어");
    // 꼬리(맘)를 뗀 김민지가 따로 후보가 되므로, 꼬리가 섞인 '지맘'은 대상이 아니다
    expect(body("민지야 지맘대로 해", { 김민지맘: "P1" })).toBe("P1야 지맘대로 해");
    // 별명 말 꼬리를 떼고, 그 말 자체나 관계 말(끝 2글자)은 둔다
    expect(body("민지야 바보야 사랑해", { 민지바보: "P1" })).toBe("P1야 바보야 사랑해");
    expect(body("하은아 사랑해", { 하은사랑: "P1" })).toBe("P1아 사랑해");
    expect(body("동료들이 민지랑", { "회사동료 민지": "P1" })).toBe("동료들이 P1랑");
  });

  it("흔한 성으로 시작하는 3글자 이름은 앞 2글자를 이름으로 보지 않는다", () => {
    expect(body("이 정도면 돼 도윤아", { 정도윤: "P1" })).toBe("이 정도면 돼 P1아");
    expect(body("고민이야 민지는", { 고민지: "P1" })).toBe("고민이야 P1는");
    expect(body("남궁 씨 민수야", { 남궁민수: "P1" })).toBe("남궁 씨 P1야");
  });

  it("이모지·괄호가 붙은 이름은 한글 덩어리로 찾고, 호칭·직함 조각은 둔다", () => {
    expect(body("민지야 김민지 왔어", { "김민지💕": "P1" })).toBe("P1야 P1 왔어");
    expect(body("민지 회사 가자", { "민지(회사)": "P1" })).toBe("P1 회사 가자");
    expect(body("민지야 우리 엄마가 그러는데", { "민지 엄마": "P1" })).toBe("P1야 우리 엄마가 그러는데");
  });

  it("한글이 아닌 이름은 대소문자를 무시하고 이름 조각도 바꾼다. 다른 단어 속은 둔다", () => {
    const latin = { "Minji Kim": "P1" };
    expect(body("Minji 어디 minji kim MINJI야 ㅋㅋMinjiㅋㅋ", latin)).toBe("P1 어디 P1 P1야 ㅋㅋP1ㅋㅋ");
    expect(body("kimchi 먹자 Kim!", latin)).toBe("kimchi 먹자 P1!");
    expect(body("Tommy 왔어 tom이랑 TOM", { Tom: "P1" })).toBe("Tommy 왔어 P1이랑 P1");
  });

  it("낱자 이름은 낱자가 이어지면 다른 말로 본다", () => {
    expect(body("ㅋㅋㅋ 웃겨 ㅋ", { ㅋ: "P1" })).toBe("ㅋㅋㅋ 웃겨 P1");
  });

  it("이름 속 정규식 특수 문자는 글자 그대로 찾는다", () => {
    expect(body("J.Kim 왔고 JxKim은 아님", { "J.Kim": "P1" })).toBe("P1 왔고 JxKim은 아님");
  });

  it("긴 이름부터: 다른 사람의 전체 이름이 짧은 이름보다 먼저다", () => {
    expect(body("김민지랑 민지", { 김민지: "P1", 민지: "P2" })).toBe("P1랑 P2");
  });

  it("시스템 문구 속 이름(systemNames)도 본문과 시스템 메시지에서 바꾼다", () => {
    const msgs = [msg("김민지", "영희 나갔네"), msg(null, "박영희님이 나갔습니다.")];
    const out = apply(msgs, { 김민지: "P1", 박영희: "P3" }, ["박영희"]);
    expect(typeof out !== "string" && out.map((m) => m.text)).toEqual(["P3 나갔네", "P3님이 나갔습니다."]);
    expect(typeof out !== "string" && out[1].sender).toBeNull();
  });
});

describe("findNameLeftovers", () => {
  const renamed = (texts: string[], map: NameMap, kinds: ChatMessage["kind"][] = []) => {
    const [first] = Object.keys(map);
    const r = applyDisplayNames(
      texts.map((t, i) => ({ ...msg(first, t), kind: kinds[i] ?? "text" })),
      map,
      [],
    );
    if (!r.ok) throw new Error(r.reason);
    return r.messages;
  };

  it("경계 규칙 때문에 남은 원래 이름 조각을 많이 남은 순서로 돌려준다", () => {
    const map = { 김민지: "P1" };
    const msgs = renamed(["민지수 왔어", "김민지야", "민지수 또 민지수", "가민지"], map);
    expect(msgs.map((m) => m.text)).toEqual(["민지수 왔어", "P1야", "민지수 또 민지수", "가민지"]);
    expect(findNameLeftovers(msgs, map)).toEqual([{ piece: "민지", count: 4, ids: [msgs[0].id, msgs[2].id, msgs[3].id] }]);
  });

  it("다 바뀌었으면 빈 배열, 표시 이름 속 말과 미디어·시스템 메시지는 세지 않는다", () => {
    expect(findNameLeftovers(renamed(["민지야 밥 먹자"], { 김민지: "P1" }), { 김민지: "P1" })).toEqual([]);
    expect(findNameLeftovers(renamed(["민지수"], { 김민지: "민지" }), { 김민지: "민지" })).toEqual([]);
    const media = renamed(["민지수"], { 김민지: "P1" }, ["photo"]);
    expect(findNameLeftovers([...media, { ...msg(null, "민지수님이 나갔습니다.") }], { 김민지: "P1" })).toEqual([]);
  });

  it.each(["우리민지", "애기민지"])("앞에 별명이 붙은 이름 %s의 끝 조각(민지)도 안다", (name) => {
    const map = { [name]: "P1" };
    const msgs = renamed(["민지야", "가민지"], map);
    expect(msgs.map((m) => m.text)).toEqual(["P1야", "가민지"]);
    expect(findNameLeftovers(msgs, map)).toEqual([{ piece: "민지", count: 1, ids: [msgs[1].id] }]);
  });

  it("한글이 아닌 조각은 대소문자를 무시하고 단어 속도 찾는다", () => {
    const map = { "Minji Kim": "P1" };
    expect(findNameLeftovers(renamed(["KIMCHI 먹자"], map), map)).toEqual([
      { piece: "Kim", count: 1, ids: [expect.any(Number)] },
    ]);
  });
});
