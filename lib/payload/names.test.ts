import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/lib/parse/parse";
import { applyDisplayNames, applyNameFixes, checkDisplayName, findNameLeftovers, type NameMap } from "./names";

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

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty", " valueOf "])(
    "Object.prototype에 있는 이름 %j → invalid (통계 맵의 키가 된다)",
    (name) => {
      expect(checkDisplayName(name)).toBe("invalid");
      expect(apply(msgs, { 김민지: name, 민지폰: "P2", 이철수: "P3" })).toBe("invalid");
    },
  );

  it("Object.prototype 이름이 들어 있기만 한 이름은 받는다", () => {
    expect(checkDisplayName("constructor2")).toBeNull();
    expect(checkDisplayName("Constructor")).toBeNull();
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
    expect(findNameLeftovers(msgs, map)).toEqual([{ piece: "민지", count: 4, ids: [msgs[0].id, msgs[2].id, msgs[3].id], suggest: true }]);
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
    expect(findNameLeftovers(msgs, map)).toEqual([{ piece: "민지", count: 1, ids: [msgs[1].id], suggest: true }]);
  });

  it("한글이 아닌 조각은 대소문자를 무시하고 단어 속도 찾는다", () => {
    const map = { "Minji Kim": "P1" };
    expect(findNameLeftovers(renamed(["KIMCHI 먹자"], map), map)).toEqual([
      { piece: "Kim", count: 1, ids: [expect.any(Number)], suggest: true },
    ]);
  });

  // 이름(김사랑·이우리)이 흔한 말(사랑·우리)과 같으면 본문에서 자동으로 바꾸지 않는다. 대신 이름처럼 쓰인 자리를
  // 확인 화면에 보여 줘서, 업로더가 모른 채 실제 이름이 나가지 않게 한다 (P2·D6)
  it("이름이 흔한 말과 같은 짧은 이름(사랑·우리)은 부르는 자리(아·야·이·가·한테…)에서 찾아 바꾸기를 권한다", () => {
    const map = { 김사랑: "멤버1", 박민지: "멤버2", 이우리: "멤버3" };
    const texts = ["사랑아 뭐해", "사랑이 어디야", "김사랑 바보", "민지야", "우리야 밥먹자", "사랑한테 물어봐", "우리가 갈게", "사랑해", "우리 집"];
    // 세 사람 모두 발신자로 넣는다(map의 이름이 대화에 있어야 본문에서 찾는다)
    const r = applyDisplayNames([...texts.map((t) => msg("김사랑", t)), msg("박민지", "응"), msg("이우리", "응")], map, []);
    if (!r.ok) throw new Error(r.reason);
    const msgs = r.messages.slice(0, texts.length);
    expect(msgs.map((m) => m.text)).toEqual([
      "사랑아 뭐해",
      "사랑이 어디야",
      "멤버1 바보",
      "멤버2야",
      "우리야 밥먹자",
      "사랑한테 물어봐",
      "우리가 갈게",
      "사랑해",
      "우리 집",
    ]);
    const left = findNameLeftovers(msgs, map);
    expect(left).toEqual([
      { piece: "사랑", count: 3, ids: [msgs[0].id, msgs[1].id, msgs[5].id], suggest: true },
      { piece: "우리", count: 2, ids: [msgs[4].id, msgs[6].id], suggest: true },
    ]);
    const fixed = applyNameFixes(msgs, { 사랑: "멤버1", 우리: "멤버3" }, map).map((m) => m.text);
    expect(fixed).toEqual([
      "멤버1아 뭐해",
      "멤버1이 어디야",
      "멤버1 바보",
      "멤버2야",
      "멤버3야 밥먹자",
      "멤버1한테 물어봐",
      "멤버3가 갈게",
      "사랑해",
      "우리 집",
    ]);
    expect(findNameLeftovers(applyNameFixes(msgs, { 사랑: "멤버1", 우리: "멤버3" }, map), map)).toEqual([]);
  });

  it("김우리: 우리야 밥먹자도 확인 화면에 나온다", () => {
    const map = { 김우리: "P1" };
    const msgs = renamed(["우리야 밥먹자"], map);
    expect(msgs[0].text).toBe("우리야 밥먹자");
    expect(findNameLeftovers(msgs, map)).toEqual([{ piece: "우리", count: 1, ids: [msgs[0].id], suggest: true }]);
  });

  // 성 모양 목록(SHAPE_SURNAMES) 밖의 성(봉·예)이어도, 3글자 이름의 끝 2글자가 흔한 말이면 부르는 자리를 확인 화면에 보여 준다 (N2)
  it.each([
    ["봉사랑", "사랑아 뭐해", "사랑"],
    ["예우리", "우리야 밥", "우리"],
    ["동아리 봉사랑", "사랑아 뭐해", "사랑"],
  ])("성 목록 밖의 '%s': '%s'는 바꾸지 않고 확인 화면에 바꾸기를 권한다", (name, text, piece) => {
    const map = { [name]: "P1" };
    const msgs = renamed([text, "사랑해 우리 집"], map);
    expect(msgs.map((m) => m.text)).toEqual([text, "사랑해 우리 집"]);
    expect(findNameLeftovers(msgs, map)).toContainEqual({ piece, count: 1, ids: [msgs[0].id], suggest: true });
    const fixed = applyNameFixes(msgs, { [piece]: "P1" }, map).map((m) => m.text);
    expect(fixed).toEqual([text.replace(piece, "P1"), "사랑해 우리 집"]);
  });
});

// 연락처 메모·관계 말·안드로이드 '회원님'처럼 사람 이름 모양이 아닌 이름에서 조각을 잘라 본문의 흔한 말을 바꾸지 않는다 (D4).
// 그런 조각은 확인 화면에 보여 주되 바꾸기를 권하지 않는다(부르는 말 "~야"로 쓰인 적이 있으면 권한다)
describe("이름 모양이 아닌 이름의 조각", () => {
  const run = (texts: string[], map: NameMap) => {
    const senders = Object.keys(map);
    const r = applyDisplayNames(
      texts.map((t, i) => msg(senders[i % senders.length], t)),
      map,
      [],
    );
    if (!r.ok) throw new Error(r.reason);
    return { texts: r.messages.map((m) => m.text), left: findNameLeftovers(r.messages, map), messages: r.messages };
  };

  it("'동아리 민수'·'교회 박지훈': 이름 조각(민수·박지훈·지훈)만 바꾸고 메모 조각(동아리·교회)은 권하지 않는 확인 항목", () => {
    const map = { "동아리 민수": "P1", "교회 박지훈": "P2" };
    const r = run(["동아리 가자", "교회 갔다 왔어", "아리가또", "민수야 밥", "지훈아 어디", "박지훈 왔다"], map);
    expect(r.texts).toEqual(["동아리 가자", "교회 갔다 왔어", "아리가또", "P1야 밥", "P2아 어디", "P2 왔다"]);
    expect(r.left).toEqual([
      { piece: "교회", count: 1, ids: [r.messages[1].id], suggest: false },
      { piece: "동아리", count: 1, ids: [r.messages[0].id], suggest: false },
    ]);
  });

  // 이름 모양(성 + 2글자) 조각이 없는 여러 조각 이름: 맨 끝 한글 조각만 이름으로 바꾸고, 나머지 조각은 확인 화면에만 (D4)
  it.each([
    ["교회 민수", "교회 갔다 왔어", "민수야 밥", "P1야 밥", "교회"],
    ["대학 지훈", "대학 가자", "지훈아 어디", "P1아 어디", "대학"],
    ["헬스 민수", "헬스 가자", "민수랑 갔어", "P1랑 갔어", "헬스"],
  ])("'%s': '%s'는 그대로 두고 확인 화면에 권하지 않는 항목으로, 이름 조각은 바꾼다", (name, common, called, renamedText, label) => {
    const map = { [name]: "P1" };
    const r = run([common, called, `${name} 왔다`], map);
    expect(r.texts).toEqual([common, renamedText, "P1 왔다"]);
    expect(r.left).toEqual([{ piece: label, count: 1, ids: [r.messages[0].id], suggest: false }]);
  });

  it("괄호 속 메모('지훈(대학)'·'(교회) 민수')는 메모로 보고, 괄호 밖 조각을 이름으로 바꾼다", () => {
    expect(run(["대학 가자", "지훈아 어디"], { "지훈(대학)": "P1" }).texts).toEqual(["대학 가자", "P1아 어디"]);
    expect(run(["교회 갔다 왔어", "민수야 밥"], { "(교회) 민수": "P1" }).texts).toEqual(["교회 갔다 왔어", "P1야 밥"]);
  });

  it("맨 끝 조각이 별명형이면 이름으로 본다('교회 민지공주')", () => {
    expect(run(["교회 가자", "민지야 밥"], { "교회 민지공주": "P1" }).texts).toEqual(["교회 가자", "P1야 밥"]);
  });

  // '민수 동아리'는 1차 수정 때 이 묶음에 있었다(이름 조각 없음). 실제 이름 민수가 바뀌지 않고 나가서(R1) 아래 묶음으로 옮겼다
  it.each([["교회 봉사랑", "교회 가자", "봉사랑 왔다", "봉사랑"]])(
    "이름 같은 조각이 없으면('%s': 메모 말 + 3글자 말) 어느 조각도 자동으로 바꾸지 않고 모두 확인 화면에 보여 준다",
    (name, common, named, piece) => {
      const r = run([common, named], { [name]: "P1" });
      expect(r.texts).toEqual([common, named]);
      expect(r.left.map((l) => l.piece)).toEqual(expect.arrayContaining([common.split(" ")[0], piece]));
    },
  );

  it("이름 같은 조각이 없을 때 3글자 조각('교회 봉민지'의 봉민지)은 성을 뺀 2글자를 확인 화면에 보여 준다(한 조각 '봉민지'와 같다)", () => {
    const map = { "교회 봉민지": "P1" };
    const r = run(["민지가 왔어", "교회 가자", "민지야 밥"], map);
    expect(r.texts).toEqual(["민지가 왔어", "교회 가자", "민지야 밥"]);
    expect(r.left).toEqual([
      { piece: "민지", count: 2, ids: [r.messages[0].id, r.messages[2].id], suggest: true },
      { piece: "교회", count: 1, ids: [r.messages[1].id], suggest: false },
    ]);
  });

  // 이름 조각은 2글자 이름(또는 별명형)에서 고른다. 1글자 조각(형·군·김)과 3글자 이상 말(동아리·대학동기)은 고르지 않는다 (R1)
  it.each([
    ["민수 형", "형이 그랬어", "민수가 왔어", "P1가 왔어"],
    ["지훈 군", "군대 간대", "지훈이 왔어", "P1이 왔어"],
    ["민지 김", "김 먹자", "민지랑 갔어", "P1랑 갔어"],
    ["민수 동아리", "동아리 가자", "민수야 밥", "P1야 밥"],
    ["지훈 대학동기", "대학동기 모임", "지훈아 어디", "P1아 어디"],
    ["민지 고등학교", "고등학교 때", "민지가 왔어", "P1가 왔어"],
    ["수아 어린이집", "어린이집 가자", "수아야 밥", "P1야 밥"],
    ["수진 헬스장", "헬스장 가자", "수진이 왔어", "P1이 왔어"],
    ["서연 과외학생", "과외학생 왔어", "서연아 숙제", "P1아 숙제"],
    ["민지 필라테스 쌤", "필라테스 가자", "민지쌤 왔어", "P1쌤 왔어"],
    ["동아리(민수)", "동아리 가자", "민수야 밥", "P1야 밥"],
  ])("'%s': '%s'는 그대로 두고 이름 조각은 바꾼다", (name, common, named, renamedText) => {
    const r = run([common, named], { [name]: "P1" });
    expect(r.texts).toEqual([common, renamedText]);
    // 실제 이름이 본문에 남지 않았다
    expect(r.left.map((l) => l.piece)).not.toContain(named.slice(0, 2));
  });

  // 메모 말(교회·대학·동기)은 이름 뒤에 와도 이름 조각으로 고르지 않는다 (R1)
  it.each([
    ["민수 교회", "교회 가자", "민수가 왔어", "P1가 왔어", "교회"],
    ["민지 대학", "대학 가자", "민지야 밥", "P1야 밥", "대학"],
    ["민지 회사 동기", "동기 모임 가자", "민지랑 갔어", "P1랑 갔어", "동기"],
    ["교회 민수 형", "교회 갔다 왔어", "민수가 왔어", "P1가 왔어", "교회"],
    ["Minji 교회", "교회 가자", "minji야 밥", "P1야 밥", "교회"],
    // 성으로 시작하는 메모 말(유치원의 유)도 성 + 2글자 이름으로 보지 않는다
    ["수아 유치원", "유치원 가자", "수아가 울었어", "P1가 울었어", "유치원"],
  ])("'%s': 메모 말('%s')은 그대로 두고 권하지 않는 확인 항목으로, 이름은 바꾼다", (name, common, named, renamedText, label) => {
    const r = run([common, named], { [name]: "P1" });
    expect(r.texts).toEqual([common, renamedText]);
    expect(r.left).toEqual([{ piece: label, count: 1, ids: [r.messages[0].id], suggest: false }]);
  });

  it("두 조각이 모두 이름 같으면('민지 수아') 맨 끝 조각을 바꾸고, 다른 조각은 확인 화면에서 바꾸기를 미리 고른다 (R1)", () => {
    const map = { "민지 수아": "P1" };
    const r = run(["수아야 밥", "민지가 왔어", "민지수 왔어"], map);
    expect(r.texts).toEqual(["P1야 밥", "민지가 왔어", "민지수 왔어"]);
    expect(r.left).toEqual([{ piece: "민지", count: 1, ids: [r.messages[1].id], suggest: true }]);
    // 확인 화면에서 바꾸면 이름 자리만 바꾼다(다른 단어 속 '민지수'는 둔다)
    expect(applyNameFixes(r.messages, { 민지: "P1" }, map).map((m) => m.text)).toEqual(["P1야 밥", "P1가 왔어", "민지수 왔어"]);
  });

  // 님으로 끝나는 직함·호칭(대리님·어머님)은 이름 조각으로 고르지 않는다. 직함은 그대로 두고 실제 이름을 바꾼다 (R2)
  it.each([
    ["지훈 대리님", "대리님 오셨어", "지훈이가 왔어", "P1이가 왔어", "대리님"],
    ["민지 과장님", "과장님이 시켰어", "민지가 했어", "P1가 했어", "과장님"],
    ["민지 팀장님", "팀장님 회의 중", "민지야 밥", "P1야 밥", "팀장님"],
    ["민수 사장님", "사장님 오셨다", "민수랑 갔어", "P1랑 갔어", "사장님"],
    ["하은 어머님", "어머님 오셨다", "하은아 밥", "P1아 밥", "어머님"],
    ["민지 대표님", "대표님 오셨다", "민지가 했어", "P1가 했어", "대표님"],
    // 성으로 시작하는 직함(이·원·차)도 성 + 2글자 이름으로 보지 않는다
    ["민지 이사님", "이사님 오셨다", "민지가 했어", "P1가 했어", "이사님"],
    ["민지 원장님", "원장님 오셨다", "민지야 밥", "P1야 밥", "원장님"],
    ["민지 차장님", "차장님 회의 중", "민지랑 갔어", "P1랑 갔어", "차장님"],
  ])("'%s': 직함·호칭('%s')은 그대로 두고 권하지 않는 확인 항목으로, 이름은 바꾼다", (name, title, named, renamedText, piece) => {
    const r = run([title, named], { [name]: "P1" });
    expect(r.texts).toEqual([title, renamedText]);
    expect(r.left).toEqual([{ piece, count: 1, ids: [r.messages[0].id], suggest: false }]);
  });

  it("님 꼬리를 떼야 이름이 남는 조각('민지님')은 다른 이름 조각이 없을 때 이름으로 본다", () => {
    expect(run(["교회 가자", "민지야 밥"], { "교회 민지님": "P1" }).texts).toEqual(["교회 가자", "P1야 밥"]);
  });

  it("2글자 이름이 있으면('민지님 수아') 그 이름을 바꾸고, 님 조각의 이름은 확인 화면에서 바꾸기를 미리 고른다", () => {
    const r = run(["수아가 왔어", "민지가 했어"], { "민지님 수아": "P1" });
    expect(r.texts).toEqual(["P1가 왔어", "민지가 했어"]);
    expect(r.left).toEqual([{ piece: "민지", count: 1, ids: [r.messages[1].id], suggest: true }]);
  });

  it("'어머님'·'원장님'·'교회 어머님': 님을 뗀 말(어머·원장)로 본문을 바꾸지 않는다", () => {
    expect(run(["어머 진짜?", "어머님 오셨어"], { 어머님: "P1" }).texts).toEqual(["어머 진짜?", "P1 오셨어"]);
    expect(run(["원장 선생님", "원장님 오셨어"], { 원장님: "P1" }).texts).toEqual(["원장 선생님", "P1 오셨어"]);
    expect(run(["어머 진짜?", "교회 가자"], { "교회 어머님": "P1" }).texts).toEqual(["어머 진짜?", "교회 가자"]);
  });

  it("'어머니'·'작은이모'·'회원님': 앞뒤를 자른 말(어머·작은·회원)로 본문을 바꾸지 않는다", () => {
    expect(run(["어머 진짜?", "어머니 오셨어"], { 어머니: "P1" }).texts).toEqual(["어머 진짜?", "P1 오셨어"]);
    expect(run(["어머 진짜?"], { 어머니: "P1" }).left).toEqual([{ piece: "어머", count: 1, ids: [expect.any(Number)], suggest: false }]);
    expect(run(["작은 문제야"], { 작은이모: "P1" }).texts).toEqual(["작은 문제야"]);
    expect(run(["회원가입 했어"], { 회원님: "P1" }).texts).toEqual(["회원가입 했어"]);
  });

  it("흔한 성 목록 밖의 성 + 2글자(변민수·진서연)도 성을 뺀 이름을 자동으로 바꾼다", () => {
    expect(run(["민수야 밥", "민수가 왔어"], { 변민수: "P1" }).texts).toEqual(["P1야 밥", "P1가 왔어"]);
    expect(run(["서연아"], { 진서연: "P1" }).texts).toEqual(["P1아"]);
  });

  it("성 + 2글자가 아닌 별명(민지쓰)의 앞 2글자는 자동으로 바꾸지 않고, 부르는 말로 쓰였으면 바꾸기를 권한다", () => {
    const map = { 민지쓰: "P1" };
    const r = run(["민지야 밥 먹자", "민지쓰 왔다"], map);
    expect(r.texts).toEqual(["민지야 밥 먹자", "P1 왔다"]);
    expect(r.left).toEqual([{ piece: "민지", count: 1, ids: [r.messages[0].id], suggest: true }]);
    // 확인 화면에서 바꾸면 이름 자리만 바꾼다(다른 단어 속은 둔다)
    expect(applyNameFixes([...r.messages, msg("민지쓰", "민지수 왔어")], { 민지: "P1" }, map).map((m) => m.text)).toEqual([
      "P1야 밥 먹자",
      "P1 왔다",
      "민지수 왔어",
    ]);
  });
});

describe("기호로만 된 이름 (D5)", () => {
  it("'.' 같은 이름은 발신자만 바꾸고 본문은 건드리지 않는다(이메일 가리기가 깨지지 않는다)", () => {
    const r = applyDisplayNames([msg(".", "먹었어... 진짜? a@b.com"), msg("김민지", "응.")], { ".": "P1", 김민지: "P2" }, []);
    if (!r.ok) throw new Error(r.reason);
    expect(r.messages.map((m) => [m.sender, m.text])).toEqual([
      ["P1", "먹었어... 진짜? a@b.com"],
      ["P2", "응."],
    ]);
  });
});
