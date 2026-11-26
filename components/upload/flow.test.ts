import { describe, expect, it } from "vitest";
import type { Payload } from "@/lib/payload/build";
import {
  conceptFor,
  defaultKind,
  excludedNames,
  includedRoots,
  initialNames,
  mergedGroups,
  mergeInto,
  NAME_PROBLEM_TEXT,
  nameMapOf,
  nameProblem,
  nameTargets,
  recognitionPercent,
  sendSummary,
  toggleExcluded,
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
  const parse = { participants: ["민지", "철수", "민지, 수아", "영희"] };
  const targets = nameTargets(parse);

  it("대상은 발신자만(알림에만 나온 이름은 없다)", () => {
    expect(targets).toEqual(["민지", "철수", "민지, 수아", "영희"]);
  });

  it("봇·알 수 없음은 이름 목록에 아예 없다", () => {
    expect(nameTargets({ participants: ["민지", "(알 수 없음)", "오픈채팅봇", "철수", "ChatGPT"] })).toEqual(["민지", "철수"]);
  });

  it("기본 표시 이름은 성을 뺀 카톡 이름(정리한 것)이다. 성을 빼서 겹치면 전체 이름", () => {
    expect(initialNames(["김민지", "이철수", "Minji"]).names).toEqual({ 김민지: "민지", 이철수: "철수", Minji: "Minji" });
    expect(initialNames(["김민지", "이민지"]).names).toEqual({ 김민지: "김민지", 이민지: "이민지" });
    expect(initialNames(["민지", "철수"]).names).toEqual({ 민지: "민지", 철수: "철수" });
    expect(initialNames(["민지.", "a|b"])).toEqual({ names: { "민지.": "민지", "a|b": "ab" }, sameAs: {}, excluded: [] });
    expect(nameProblem(initialNames(targets), targets)).toBeNull();
  });

  it("두 사람에게 같은 이름·빈 이름·금지 문자·전화번호는 막는다", () => {
    const base = initialNames(targets);
    const withName = (name: string) => ({ ...base, names: { ...base.names, 철수: name } });
    expect(nameProblem(withName("민지"), targets)).toBe("collision");
    expect(nameProblem(withName("  "), targets)).toBe("empty");
    expect(nameProblem(withName("a|b"), targets)).toBe("invalid");
    expect(nameProblem(withName("010-1234-5678"), targets)).toBe("invalid");
    expect(nameProblem(withName("점심왕"), targets)).toBeNull();
    for (const reason of ["collision", "empty", "invalid", "unmapped", "too_few"] as const) expect(NAME_PROBLEM_TEXT[reason]).toBeTruthy();
    expect(NAME_PROBLEM_TEXT.too_few).toBe("분석할 사람이 2명 이상 남아야 AI 리포트를 만들 수 있어요.");
    expect(NAME_PROBLEM_TEXT.invalid).toContain("전화번호·계좌 같은 숫자는 이름에 쓸 수 없어요");
  });

  it("이름 맵의 값은 앞뒤 공백을 뗀다", () => {
    const state = initialNames(targets);
    expect(nameMapOf({ ...state, names: { ...state.names, 민지: "  별님 " } }, targets).민지).toBe("별님");
  });

  it("[같은 사람]으로 합치면 같은 표시 이름을 쓰고 collision이 아니다", () => {
    let state = initialNames(targets);
    state = { ...state, sameAs: mergeInto(state.sameAs, "민지, 수아", "민지") };
    expect(nameMapOf(state, targets)).toMatchObject({ 민지: "민지", "민지, 수아": "민지" });
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
});

describe("분석에서 빼기", () => {
  const targets = ["민지", "철수", "수아", "영희"];

  it("(Review Focus 1) 수아를 민지에 합치고 민지를 빼면 둘 다 빠진다", () => {
    let state = initialNames(targets);
    state = { ...state, sameAs: mergeInto(state.sameAs, "수아", "민지") };
    state = toggleExcluded(state, "민지");
    expect([...excludedNames(state, targets)].sort()).toEqual(["민지", "수아"]);
    expect(includedRoots(state, targets)).toEqual(["철수", "영희"]);
  });

  it("토글은 대표에만 먹고, 다시 누르면 넣는다", () => {
    let state = initialNames(targets);
    state = { ...state, sameAs: mergeInto(state.sameAs, "수아", "민지") };
    expect(toggleExcluded(state, "수아")).toBe(state);
    state = toggleExcluded(state, "영희");
    expect(state.excluded).toEqual(["영희"]);
    expect(toggleExcluded(state, "영희").excluded).toEqual([]);
  });

  it("넣은 대표가 2명 미만이면 too_few", () => {
    let state = initialNames(targets);
    for (const who of ["철수", "수아"]) state = toggleExcluded(state, who);
    expect(nameProblem(state, targets)).toBeNull();
    state = toggleExcluded(state, "영희");
    expect(nameProblem(state, targets)).toBe("too_few");
  });

  it("뺀 사람의 빈 이름·겹치는 이름은 문제가 아니다", () => {
    let state = initialNames(targets);
    state = { ...state, names: { ...state.names, 영희: "", 수아: "민지" } };
    expect(nameProblem(state, targets)).not.toBeNull();
    state = toggleExcluded(toggleExcluded(state, "영희"), "수아");
    expect(nameProblem(state, targets)).toBeNull();
  });
});

describe("확인 화면", () => {
  it("인식률은 내려서 정수 %로 보여 준다(98% 미만을 98%로 보이지 않게)", () => {
    expect([1, 0.9999, 0.979, 0].map(recognitionPercent)).toEqual([100, 99, 97, 0]);
  });
});

describe("sendSummary", () => {
  const transcript = ["# 2024-03-01", "m0|00:05|A|첫", "# 2024-03-15", ...Array.from({ length: 23 }, (_, i) => `m${106 + i}|09:00|A|줄 ${i}`)].join("\n");
  const payload = {
    members: ["민지", "철수"],
    period: { start: "2024-03-01", end: "2024-03-15" },
    msgTotal: 130,
    cutoffAt: "2024-03-01T00:05:00+09:00",
    msgSent: 24,
    anchors: "",
    transcript,
    maskCounts: { phone: 1, email: 0, account: 0, rrn: 0, url: 2 },
  } as unknown as Payload;
  const excluded = [{ name: "영희", count: 3 }];

  it("보낼 범위·가린 수·뺀 멤버·범례·미리보기(범례 다음 20줄)", () => {
    const s = sendSummary(payload, excluded);
    expect(s).toEqual({
      period: "2024-03-01 ~ 2024-03-15",
      total: 130,
      sent: 24,
      masked: 3,
      excluded: [{ name: "영희", count: 3 }],
      legend: [
        { code: "A", name: "민지" },
        { code: "B", name: "철수" },
      ],
      preview: ["A=민지", "B=철수", ...transcript.split("\n").slice(0, 20)],
    });
  });
});
