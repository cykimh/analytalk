import { describe, expect, it } from "vitest";
import type { Payload } from "@/lib/payload/build";
import type { ChatMessage } from "@/lib/parse/parse";
import {
  conceptFor,
  defaultKind,
  initialNames,
  leftoverOwner,
  mergedGroups,
  mergeInto,
  NAME_PROBLEM_TEXT,
  nameMapOf,
  nameProblem,
  nameTargets,
  recognitionPercent,
  sendSummary,
  unmerge,
} from "./flow";

describe("방 종류", () => {
  it("기본값은 참여자 수로 정한다(2명 이하 1:1, 그 밖 단톡)", () => {
    expect([1, 2, 3, 30].map(defaultKind)).toEqual(["pair", "pair", "group", "group"]);
  });

  it("컨셉은 kind에 맞는 것만: pair → couple, group·work → group", () => {
    expect([conceptFor("pair"), conceptFor("group"), conceptFor("work")]).toEqual(["couple", "group", "group"]);
  });
});

describe("이름 정리", () => {
  const parse = { participants: ["민지", "철수", "민지, 수아", "영희"], systemNames: ["영희", "지훈"] };
  const targets = nameTargets(parse);

  it("대상은 발신자 다음에 알림에만 나온 이름", () => {
    expect(targets).toEqual(["민지", "철수", "민지, 수아", "영희", "지훈"]);
  });

  it("기본 표시 이름은 멤버1…이고 원래 이름을 쓰지 않는다", () => {
    expect(initialNames(targets)).toEqual({
      names: { 민지: "멤버1", 철수: "멤버2", "민지, 수아": "멤버3", 영희: "멤버4", 지훈: "멤버5" },
      sameAs: {},
    });
    expect(nameProblem(initialNames(targets), targets)).toBeNull();
  });

  it("두 사람에게 같은 이름·빈 이름·금지 문자는 applyDisplayNames와 같은 이유로 막는다", () => {
    const base = initialNames(targets);
    const withName = (name: string) => ({ ...base, names: { ...base.names, 철수: name } });
    expect(nameProblem(withName("멤버1"), targets)).toBe("collision");
    expect(nameProblem(withName("  "), targets)).toBe("empty");
    expect(nameProblem(withName("a|b"), targets)).toBe("invalid");
    expect(nameProblem(withName("constructor"), targets)).toBe("invalid");
    expect(nameProblem(withName("점심왕"), targets)).toBeNull();
    for (const reason of ["collision", "empty", "invalid", "unmapped"] as const) expect(NAME_PROBLEM_TEXT[reason]).toBeTruthy();
  });

  it("이름 맵의 값은 앞뒤 공백을 뗀다(applyDisplayNames가 쓰는 이름과 me가 같아야 한다)", () => {
    const state = initialNames(targets);
    expect(nameMapOf({ ...state, names: { ...state.names, 민지: "  별님 " } }, targets).민지).toBe("별님");
  });

  it("[같은 사람]으로 합치면 같은 표시 이름을 쓰고 collision이 아니다", () => {
    let state = initialNames(targets);
    state = { ...state, sameAs: mergeInto(state.sameAs, "민지, 수아", "민지") };
    expect(nameMapOf(state, targets)).toMatchObject({ 민지: "멤버1", "민지, 수아": "멤버1" });
    expect(mergedGroups(state.sameAs)).toEqual([["민지", "민지, 수아"]]);
    expect(nameProblem(state, targets)).toBeNull();
  });

  it("합쳐진 사람을 품은 사람을 다시 합치면 모두 새 대표를 따른다. 풀면 혼자로 돌아간다", () => {
    let sameAs = mergeInto({}, "민지, 수아", "민지");
    sameAs = mergeInto(sameAs, "민지", "철수");
    expect(sameAs).toEqual({ "민지, 수아": "철수", 민지: "철수" });
    expect(mergedGroups(sameAs)).toEqual([["철수", "민지, 수아", "민지"]]);
    expect(unmerge(sameAs, "민지")).toEqual({ "민지, 수아": "철수" });
  });

  it("남은 조각의 주인: 조각을 품은 원래 이름이 한 표시 이름으로만 이어지면 그 이름", () => {
    const map = { 김민지: "P1", "Minji Kim": "P1", 이민지: "P2", 철수: "P3" };
    expect(leftoverOwner("김민", map)).toBe("P1");
    expect(leftoverOwner("minji", map)).toBe("P1");
    expect(leftoverOwner("민지", map)).toBeNull();
    expect(leftoverOwner("영희", map)).toBeNull();
  });
});

describe("확인 화면", () => {
  it("인식률은 내려서 정수 %로 보여 준다(98% 미만을 98%로 보이지 않게)", () => {
    expect([1, 0.9999, 0.979, 0].map(recognitionPercent)).toEqual([100, 99, 97, 0]);
  });
});

describe("sendSummary", () => {
  const chat = (id: number, kind: ChatMessage["kind"] = "text"): ChatMessage => ({
    id,
    ts: 0,
    sender: kind === "system" ? null : "P1",
    kind,
    text: "x",
    line: id + 1,
  });
  // id 5가 시스템 메시지라 첫 대화 100개는 id 0~4, 6~100이다
  const messages = Array.from({ length: 130 }, (_, id) => chat(id, id === 5 ? "system" : "text"));
  const transcript = ["# 2024-03-15", ...Array.from({ length: 24 }, (_, i) => `m${106 + i}|09:00|A|줄 ${i}`)].join("\n");
  const payload = {
    members: ["P1", "P2"],
    cutoffAt: "2024-03-15T09:00:00+09:00",
    msgSent: 24,
    anchors: ["# 2024-03-14", "m0|00:05|A|첫", "m100|00:06|A|백", "# 2024-03-15", "m101|08:00|A|활발"].join("\n"),
    transcript,
    maskCounts: { phone: 1, email: 0, account: 0, rrn: 0, url: 2 },
  } as unknown as Payload;

  it("보낼 범위·가린 수·미리보기(범례 다음 20줄)", () => {
    const s = sendSummary(payload, messages);
    expect(s).toMatchObject({ since: "2024-03-15", sent: 24, first: 2, busy: 1, masked: 3 });
    expect(s.preview).toEqual(["A=P1", "B=P2", ...transcript.split("\n").slice(0, 20)]);
  });

  it("anchors가 비면(대화 전체가 transcript) 첫 대화·활발한 날은 0", () => {
    expect(sendSummary({ ...payload, anchors: "" }, messages)).toMatchObject({ first: 0, busy: 0 });
  });
});
