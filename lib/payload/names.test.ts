import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/lib/parse/parse";
import { applyDisplayNames, checkDisplayName, type NameMap } from "./names";

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

  it("앞이 한글이면 그대로, 조사·공백·기호 앞뒤면 바꾼다", () => {
    expect(body("우리민지 왔어")).toBe("우리민지 왔어");
    expect(body("@김민지님 민지한테 줘 (민지)")).toBe("@P1님 P1한테 줘 (P1)");
    expect(body("ㅋㅋ민지는 민지씨 민지도")).toBe("ㅋㅋP1는 P1씨 P1도");
  });

  it("목록 밖의 흔한 조사·호칭(을·를·에·으로·언니 등)이 붙어도 바꾼다", () => {
    expect(body("김민지를 봤어 민지언니랑 민지네 민지에게")).toBe("P1를 봤어 P1언니랑 P1네 P1에게");
    expect(body("민지폰으로 보냄", { 김민지: "P1", 민지폰: "P1" }, [["김민지", "민지폰"]])).toBe("P1으로 보냄");
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
