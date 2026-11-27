import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/lib/parse/parse";
import {
  applyDisplayNames,
  checkDisplayName,
  checkNameMap,
  defaultDisplayName,
  defaultNames,
  isBotOrUnknown,
  type NameOptions,
} from "./names";
import { reportNames } from "./names";

let seq = 0;
function msg(sender: string | null, text = "안녕"): ChatMessage {
  const id = seq++;
  return { id, ts: Date.UTC(2026, 9, 1) + id * 60_000, sender, kind: sender === null ? "system" : "text", text, line: id + 1 };
}

function apply(msgs: ChatMessage[], o: NameOptions) {
  const r = applyDisplayNames(msgs, o);
  return r.ok ? r.messages : r.reason;
}

describe("checkDisplayName", () => {
  it.each(["a|b", "a.b", "{a}", "a\nb", "<b>", "가".repeat(21)])("금지 문자·21자 %j → invalid", (bad) => {
    expect(checkDisplayName(bad)).toBe("invalid");
  });

  it("빈 이름 → empty", () => {
    expect(checkDisplayName("  ")).toBe("empty");
  });

  it.each(["constructor", "__proto__", " valueOf "])("Object.prototype 이름 %j → invalid", (name) => {
    expect(checkDisplayName(name)).toBe("invalid");
  });

  it("20자와 이모지 20개는 받는다", () => {
    expect(checkDisplayName("가".repeat(20))).toBeNull();
    expect(checkDisplayName("😀".repeat(20))).toBeNull();
  });

  it("(Review Focus 5) 전화번호 모양 이름은 invalid", () => {
    expect(checkDisplayName("010-1234-5678")).toBe("invalid");
    expect(checkDisplayName("민지")).toBeNull();
  });
});

describe("defaultDisplayName (Review Focus 5)", () => {
  it("금지 글자를 빼고 공백을 하나로 모은다", () => {
    expect(defaultDisplayName("민지.")).toBe("민지");
    expect(defaultDisplayName("a|b")).toBe("ab");
    expect(defaultDisplayName("  민지   수아 ")).toBe("민지 수아");
  });

  it("25자는 20자로 자른다(코드 포인트)", () => {
    expect([...defaultDisplayName("가".repeat(25))]).toHaveLength(20);
    expect([...defaultDisplayName("😀".repeat(25))]).toHaveLength(20);
  });

  it("그래도 못 쓰는 이름은 원래 이름 그대로(화면이 막고 이유를 보인다)", () => {
    expect(defaultDisplayName("010-1234-5678")).toBe("010-1234-5678");
    expect(defaultDisplayName("...")).toBe("...");
    expect(defaultDisplayName("constructor")).toBe("constructor");
  });
});

describe("defaultDisplayName: 성을 뺀 이름", () => {
  it.each([
    ["김민지", "민지"],
    ["이철수", "철수"],
    ["박서연", "서연"],
    ["변민수", "민수"],
    // '아'·'라'로 끝나는 흔한 이름은 호칭으로 보지 않는다
    ["김수아", "수아"],
    ["이세라", "세라"],
    ["독수리", "독수리"],
    [" 김민지 ", "민지"],
  ])("한글 3글자이고 첫 글자가 흔한 성이면 뒤 두 글자: %j → %j", (name, want) => {
    expect(defaultDisplayName(name)).toBe(want);
  });

  it.each(["민지", "Minji", "김민지야요", "김민지수", "남궁민수", "김 민지", "김MJ", "황보민", "남궁민", "제갈량", "선우진", "독고진", "서문탁"])(
    "다른 모양(2글자·4글자 이상·영문·공백·2글자 성 + 1글자)은 그대로: %j",
    (name) => {
      expect(defaultDisplayName(name)).toBe(name.trim());
    },
  );
});

describe("defaultDisplayName: 호칭·별명은 성을 떼지 않는다", () => {
  it.each([
    // 직함 + 님(○장님 등)
    "부장님", "사장님", "차장님", "원장님", "소장님", "국장님", "반장님", "선생님", "주임님", "사모님",
    // 가족·애칭
    "어머니", "이모님", "고모님", "장모님", "남편님", "우리딸", "우리집", "여보야", "마누라", "자기야",
    // 이름 + 애칭·호칭 접미(이·아·야·씨·쌤·맘 …)
    "하늘이", "지은이", "민지씨", "지우맘", "국어쌤", "민수군",
    // 성 + 직함·관계(김부장 → 부장으로 줄이면 누군지 모른다)
    "김부장", "박과장", "이대리", "최목사", "정교수", "남동생", "여동생", "고모부", "이모부", "전남친", "사촌형",
  ])("그대로: %j", (name) => {
    expect(defaultDisplayName(name)).toBe(name);
  });
});

describe("defaultNames", () => {
  it("발신자마다 기본 표시 이름을 준다", () => {
    expect(defaultNames(["김민지", "이철수", "Minji"])).toEqual({ 김민지: "민지", 이철수: "철수", Minji: "Minji" });
  });

  it("성을 빼서 다른 사람과 겹치면 그 사람(들)은 전체 이름으로 둔다", () => {
    expect(defaultNames(["김민지", "이민지", "박철수"])).toEqual({ 김민지: "김민지", 이민지: "이민지", 박철수: "철수" });
    expect(defaultNames(["김민지", "민지"])).toEqual({ 김민지: "김민지", 민지: "민지" });
  });
});

describe("isBotOrUnknown", () => {
  it.each([
    "(알 수 없음)",
    "알 수 없음",
    "(알수없음)",
    "오픈채팅봇",
    "채팅봇",
    "알림봇",
    "로봇",
    "MyBot",
    "helperbot",
    "BOT",
    "ChatGPT",
    "chatgpt 도우미",
    "GPT",
    "챗GPT",
    "카카오톡",
    "카카오톡 고객센터",
  ])("봇·알 수 없음: %j", (name) => {
    expect(isBotOrUnknown(name)).toBe(true);
  });

  it.each(["민지", "봇짱", "Bottle", "봇 민지", "김철수", "robot man"])("사람 이름: %j", (name) => {
    expect(isBotOrUnknown(name)).toBe(false);
  });
});

describe("checkNameMap", () => {
  it("map에 없는 이름 → unmapped, 같은 이름 → collision, 합친 묶음은 예외", () => {
    expect(checkNameMap({ 민지: "A" }, ["민지", "철수"])).toBe("unmapped");
    expect(checkNameMap({ 민지: "A", 철수: "A" }, ["민지", "철수"])).toBe("collision");
    expect(checkNameMap({ 민지: "A", 철수: "A" }, ["민지", "철수"], [["민지", "철수"]])).toBeNull();
    expect(checkNameMap({ 민지: "", 철수: "B" }, ["민지", "철수"])).toBe("empty");
  });
});

describe("applyDisplayNames", () => {
  it("발신자만 표시 이름으로 바꾸고 합친 별칭은 같은 이름을 쓴다", () => {
    const msgs = [msg("김민지"), msg("민지폰"), msg("이철수"), msg(null, "수아님이 들어왔습니다")];
    const out = apply(msgs, { map: { 김민지: "민지", 민지폰: "민지", 이철수: "철수" }, merged: [["김민지", "민지폰"]] });
    expect(typeof out !== "string" && out.map((m) => m.sender)).toEqual(["민지", "민지", "철수", null]);
  });

  it("묶지 않은 두 사람에게 같은 이름 → collision, 빈 이름 → empty, 매핑 없음 → unmapped", () => {
    const msgs = [msg("김민지"), msg("이철수")];
    expect(apply(msgs, { map: { 김민지: "P", 이철수: "P" } })).toBe("collision");
    expect(apply(msgs, { map: { 김민지: "", 이철수: "P" } })).toBe("empty");
    expect(apply(msgs, { map: { 김민지: "P" } })).toBe("unmapped");
  });

  it("뺀 사람 메시지는 빠지고 남은 메시지의 id·순서·text는 그대로", () => {
    const msgs = [msg("민지", "가"), msg("영희", "나"), msg("철수", "다"), msg("영희", "라")];
    const out = apply(msgs, { map: { 민지: "민지", 철수: "철수", 영희: "영희" }, excluded: ["영희"] });
    expect(out).toEqual([msgs[0], msgs[2]]);
  });

  it("(Review Focus 1) 본문 속 이름은 그 사람을 빼도 한 글자도 안 바뀐다", () => {
    const msgs = [msg("민지", "영희야 밥 먹자"), msg("영희", "응"), msg("철수", "민지야 영희 어디야")];
    const out = apply(msgs, { map: { 민지: "별", 철수: "달", 영희: "영희" }, excluded: ["영희"] });
    expect(typeof out !== "string" && out.map((m) => m.text)).toEqual(["영희야 밥 먹자", "민지야 영희 어디야"]);
  });

  it("뺀 사람은 빈 이름·남과 같은 이름이어도 ok", () => {
    const msgs = [msg("민지"), msg("영희"), msg("수아")];
    expect(apply(msgs, { map: { 민지: "민지", 영희: "", 수아: "민지" }, excluded: ["영희", "수아"] })).toHaveLength(1);
  });

  it("(Review Focus 1) 뺀 대표에게 합친 사람까지 excluded로 넘기면 모두 빠진다", () => {
    const msgs = [msg("민지"), msg("민지폰"), msg("철수"), msg("영희")];
    const out = apply(msgs, { map: { 철수: "철수", 영희: "영희" }, excluded: ["민지", "민지폰"], merged: [["민지", "민지폰"]] });
    expect(typeof out !== "string" && out.map((m) => m.sender)).toEqual(["철수", "영희"]);
  });

  it("봇·알 수 없음의 메시지는 excluded에 없어도 빠지고 이름도 필요 없다", () => {
    const msgs = [msg("민지"), msg("(알 수 없음)"), msg("오픈채팅봇"), msg("철수")];
    const out = apply(msgs, { map: { 민지: "민지", 철수: "철수" } });
    expect(typeof out !== "string" && out.map((m) => m.sender)).toEqual(["민지", "철수"]);
  });

  it("입력 메시지는 바꾸지 않는다", () => {
    const msgs = [msg("김민지")];
    apply(msgs, { map: { 김민지: "민지" } });
    expect(msgs[0].sender).toBe("김민지");
  });
});

describe("reportNames: 리포트에는 성을 뺀 이름", () => {
  it("입력칸에 성을 붙였든 뺐든 성을 뺀다", () => {
    expect(reportNames({ a: "김민지", b: "철수" }, ["a", "b"])).toEqual({ a: "민지", b: "철수" });
    expect(reportNames({ a: "민지" }, ["a"])).toEqual({ a: "민지" });
  });
  it("호칭·두 글자 성은 그대로", () => {
    expect(reportNames({ a: "김부장", b: "남궁민" }, ["a", "b"])).toEqual({ a: "김부장", b: "남궁민" });
  });
  it("성을 빼면 겹치는 두 사람은 입력한 이름 그대로", () => {
    expect(reportNames({ a: "김민지", b: "이민지", c: "박철수" }, ["a", "b", "c"])).toEqual({ a: "김민지", b: "이민지", c: "철수" });
    expect(reportNames({ a: "김민지", b: "민지" }, ["a", "b"])).toEqual({ a: "김민지", b: "민지" });
  });
  it("[같은 사람]으로 합친 묶음은 겹쳐도 한 사람이다", () => {
    expect(reportNames({ a: "김민지", b: "김민지" }, ["a", "b"], [["a", "b"]])).toEqual({ a: "민지", b: "민지" });
  });
  it("applyDisplayNames는 리포트 이름으로 발신자를 바꾼다", () => {
    const r = applyDisplayNames(
      [
        { id: 1, ts: 0, sender: "a", kind: "text", text: "안녕" },
        { id: 2, ts: 1, sender: "b", kind: "text", text: "응" },
      ] as never,
      { map: { a: "김민지", b: "박철수" } },
    );
    expect(r.ok && r.messages.map((m) => m.sender)).toEqual(["민지", "철수"]);
  });
});
