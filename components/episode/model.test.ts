import { describe, expect, it } from "vitest";
import {
  formatAt,
  isActive,
  isSettled,
  kstDay,
  mergeNotes,
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
  it("readRange: transcript 첫 메시지의 KST 날짜와 보낸 메시지 수", () => {
    // 2026-09-30 15:00Z = 2026-10-01 00:00 KST
    expect(readRange("2026-09-30T15:00:00.000Z", 6240)).toBe("2026-10-01 이후 6,240개");
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
