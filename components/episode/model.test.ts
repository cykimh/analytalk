import { describe, expect, it } from "vitest";
import {
  formatAt,
  groupStages,
  isActive,
  isSettled,
  kstDay,
  mergeNotes,
  placeEvidence,
  readRange,
  reportAction,
  reportPhase,
  retryKept,
} from "./model";

describe("isActive (폴링을 계속할지)", () => {
  it.each([
    ["running", true],
    ["queued", true],
    ["done", false],
    ["partial", false],
    ["failed", false],
    ["refused", false],
    ["safety", false],
  ])("%s → %s", (status, expected) => {
    expect(isActive(status)).toBe(expected);
  });
});

describe("isSettled (이 브라우저의 페이로드를 지워도 되는지)", () => {
  it.each([
    ["done", true],
    ["refused", true],
    ["safety", true],
    ["queued", false],
    ["running", false],
    ["failed", false],
    ["partial", false],
  ])("%s → %s", (status, expected) => {
    expect(isSettled(status)).toBe(expected);
  });
});

describe("mergeNotes (reading_notes 쌓기)", () => {
  const a = { range: "10-01~10-03", note: "저녁마다 이야기했다" };
  const b = { range: "10-04~10-09", note: "주말엔 조용했다" };

  it("처음 본 메모를 차례로 붙이고, 같은 메모는 한 번만", () => {
    const one = mergeNotes([], [a]);
    expect(one).toEqual([a]);
    expect(mergeNotes(one, [a, b])).toEqual([a, b]);
  });

  it("progress가 없거나 바뀐 게 없으면 prev 그대로(같은 참조)", () => {
    const prev = [a];
    expect(mergeNotes(prev, null)).toBe(prev);
    expect(mergeNotes(prev, [a])).toBe(prev);
    expect(mergeNotes(prev, { range: "x", note: "y" })).toBe(prev);
  });

  it("모양이 틀린 값은 버린다", () => {
    expect(mergeNotes([a], [{ range: 1 }, "x", b])).toEqual([a, b]);
  });
});

describe("reportPhase (카드의 상태 줄)", () => {
  it.each([
    ["queued", false, "AI가 대화를 읽는 중"],
    ["running", false, "AI가 대화를 읽는 중"],
    ["running", true, "쓰는 중"],
    ["done", false, "다 썼어요"],
    ["partial", false, "일부만 썼어요"],
    ["failed", false, "쓰지 못했어요"],
    ["refused", false, "AI가 이 대화로는 리포트를 쓰지 않았어요"],
    ["safety", false, "리포트를 쓰지 않았어요"],
  ])("%s·메모 %s → %s", (status, hasNote, text) => {
    expect(reportPhase(status, hasNote)).toBe(text);
  });
});

describe("reportAction (카드의 버튼)", () => {
  it("done은 읽기, partial은 읽기 + 다시 쓰기, failed는 다시 쓰기", () => {
    expect(reportAction("done", false)).toEqual({ read: true, retry: null });
    expect(reportAction("partial", false)).toEqual({ read: true, retry: "button" });
    expect(reportAction("failed", false)).toEqual({ read: false, retry: "button" });
  });

  it("정지 중이면 [다시 쓰기] 대신 마감 안내", () => {
    expect(reportAction("failed", true)).toEqual({ read: false, retry: "paused" });
    expect(reportAction("partial", true)).toEqual({ read: true, retry: "paused" });
  });

  it("그 밖의 상태는 버튼이 없다", () => {
    for (const s of ["queued", "running", "refused", "safety"]) expect(reportAction(s, false)).toEqual({ read: false, retry: null });
  });
});

describe("날짜·시각 (KST)", () => {
  it("readRange: 전체 기간에서 보낸 메시지 수", () => {
    expect(readRange(6240)).toBe("전체 기간에서 6,240개");
  });

  it("kstDay·formatAt", () => {
    expect(kstDay("2026-12-24T14:59:59.000Z")).toBe("2026-12-24");
    expect(kstDay("2026-12-24T15:00:00.000Z")).toBe("2026-12-25");
    expect(formatAt("2026-10-01T20:05:00+09:00")).toBe("2026-10-01 20:05");
    expect(formatAt("2026-10-01T23:59:00Z")).toBe("2026-10-02 08:59");
    expect(formatAt("시각 아님")).toBe("");
  });
});

describe("retryKept (다시 쓰기가 실패해 앞의 글을 남겼다)", () => {
  it("partial인데 오류 코드가 있으면 true(잘라 살린 partial은 오류 코드가 없다)", () => {
    expect(retryKept("partial", "retryable")).toBe(true);
    expect(retryKept("partial", null)).toBe(false);
    expect(retryKept("failed", "retryable")).toBe(false);
  });
});

describe("placeEvidence", () => {
  const e = (id: string) => ({ id, msg_id: "m1", quote: id, sender: "민지", at: "2026-10-01T20:04:00+09:00" });
  const p = (key: string, evidence_ids: string[]) => ({ key, text: key, evidence_ids });
  const section = (paragraphs: ReturnType<typeof p>[], evidence: ReturnType<typeof e>[]) => ({
    part: "nag_cards",
    icon: "🙄",
    title: "t",
    about: "민지",
    paragraphs,
    evidence,
  });
  const shape = (rows: ReturnType<typeof placeEvidence>) => rows.map((r) => [r.paragraph?.key ?? null, r.evidence.map((x) => [x.e.id, x.index])]);

  it("근거 말풍선은 그 근거를 처음 쓴 문단 바로 아래에 한 번만, 섹션 안 순서(index)는 그대로", () => {
    const rows = placeEvidence(section([p("p1", ["e2"]), p("p2", []), p("p3", ["e2", "e1", "e9"])], [e("e1"), e("e2")]));
    expect(shape(rows)).toEqual([
      ["p1", [["e2", 1]]],
      ["p2", []],
      ["p3", [["e1", 0]]],
    ]);
  });

  it("어느 문단도 쓰지 않는 근거(예전 리포트)는 섹션 끝에 모아 둔다", () => {
    expect(shape(placeEvidence(section([p("p1", [])], [e("e1"), e("e2")])))).toEqual([
      ["p1", []],
      [null, [["e1", 0], ["e2", 1]]],
    ]);
  });
});

describe("groupStages (v2.4: 종합 → 멤버별 → 마무리)", () => {
  const s = (part: string, about = "group") => ({ part, about });
  const shape = (sections: { part: string; about: string }[]) =>
    groupStages(sections).map((g) => [g.stage, g.sections.map((x) => x.index)]);

  it("첫 사람 섹션 앞은 종합, 사람 섹션들은 멤버별(그 밖의 멤버 섹션 포함), 그 뒤는 마무리", () => {
    const sections = [
      s("case_brief"),
      s("case_timeline"),
      s("case_people", "민수"),
      s("case_people", "으리"),
      s("case_others"),
      s("case_open"),
      s("case_verdict"),
    ];
    expect(shape(sections)).toEqual([
      ["intro", [0, 1]],
      ["people", [2, 3, 4]],
      ["outro", [5, 6]],
    ]);
  });

  it("예전 구성(v2.3: 사람 카드 뒤에 방 전체 구성)·구성 키가 빈 행도 자리로 나눈다", () => {
    expect(shape([s("nag_open"), s("nag_cards", "철수"), s("", "민지"), s("nag_room"), s("nag_last")])).toEqual([
      ["intro", [0]],
      ["people", [1, 2]],
      ["outro", [3, 4]],
    ]);
  });

  it("구성 키가 마무리(outro)면 about이 사람이어도 마무리다(Fix 1: 수사 결론이 범인을 지목할 때)", () => {
    expect(shape([s("case_brief"), s("case_people", "민수"), s("case_people", "으리"), s("case_open"), s("case_verdict", "민수")])).toEqual([
      ["intro", [0]],
      ["people", [1, 2]],
      ["outro", [3, 4]],
    ]);
    // 인트로의 about이 사람이어도 종합, 그 밖의 멤버(others)는 멤버별, 모르는 키는 about이 사람이면 멤버별이고 아니면 앞 섹션을 따른다
    expect(shape([s("show_open", "민지"), s("show_cast", "민지"), s("", "철수"), s("show_others"), s("show_close", "철수"), s("")])).toEqual([
      ["intro", [0]],
      ["people", [1, 2, 3]],
      ["outro", [4, 5]],
    ]);
  });

  it("사람 섹션이 없으면 한 부분(종합)뿐이고, 빈 리포트는 부분이 없다", () => {
    expect(shape([s("map", "pair"), s("nag_room")])).toEqual([["intro", [0, 1]]]);
    expect(shape([])).toEqual([]);
    // 사람 섹션으로 시작하면 종합이 없다
    expect(shape([s("show_cast", "민지"), s("show_close")])).toEqual([
      ["people", [0]],
      ["outro", [1]],
    ]);
  });
});
