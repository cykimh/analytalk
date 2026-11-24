import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/lib/parse/parse";
import { computeStats } from "@/lib/stats/compute";
import {
  episodeAction,
  formatAt,
  retryKept,
  isActive,
  isSettled,
  kstDay,
  mergeEpisodeNotes,
  readRange,
  statCards,
  statusChanged,
} from "./model";

const eps = (...statuses: string[]) => statuses.map((status, i) => ({ n: i + 1, status }));

describe("isActive (폴링을 계속할지)", () => {
  it("쓰는 편이 있거나, 1편이 시작·완료됐고 기다리는 편이 있으면 true", () => {
    expect(isActive(eps("running", "queued", "queued", "queued"))).toBe(true);
    expect(isActive(eps("done", "running", "done", "queued"))).toBe(true);
    expect(isActive(eps("done", "queued", "queued", "queued"))).toBe(true);
    expect(isActive(eps("partial", "done", "done", "queued"))).toBe(true);
    expect(isActive(eps("failed", "running", "done", "done"))).toBe(true);
  });

  it("1편이 실패해 2~4편이 기다리기만 하거나, 모두 끝났으면 false([다시 쓰기]를 기다린다)", () => {
    expect(isActive(eps("failed", "queued", "queued", "queued"))).toBe(false);
    expect(isActive(eps("refused", "queued", "queued", "queued"))).toBe(false);
    expect(isActive(eps("done", "failed", "partial", "done"))).toBe(false);
    expect(isActive(eps("done", "done", "done", "done"))).toBe(false);
  });
});

describe("isSettled (이 브라우저의 페이로드를 지워도 되는지)", () => {
  it("다시 쓸 수 있거나 쓰는 중인 편이 하나도 없으면 true", () => {
    expect(isSettled(eps("done", "done", "done", "done"))).toBe(true);
    expect(isSettled(eps("done", "refused", "safety", "done"))).toBe(true);
  });

  it("queued·running·failed·partial이 남았거나 편이 없으면 false", () => {
    expect(isSettled(eps("done", "done", "done", "partial"))).toBe(false);
    expect(isSettled(eps("done", "failed", "done", "done"))).toBe(false);
    expect(isSettled(eps("done", "running", "done", "done"))).toBe(false);
    expect(isSettled(eps("done", "queued", "done", "done"))).toBe(false);
    expect(isSettled([])).toBe(false);
  });
});

describe("statusChanged", () => {
  it("편 상태가 하나라도 다르면 true(대화 내용을 다시 읽는다)", () => {
    expect(statusChanged(eps("running", "queued"), eps("running", "queued"))).toBe(false);
    expect(statusChanged(eps("running", "queued"), eps("done", "queued"))).toBe(true);
    expect(statusChanged(eps("running"), eps("running", "queued"))).toBe(true);
  });
});

describe("mergeEpisodeNotes (편별 reading_notes 쌓기)", () => {
  const a = { range: "10-01~10-03", note: "저녁마다 이야기했다" };
  const b = { range: "10-04~10-09", note: "주말엔 조용했다" };

  it("편마다 처음 본 메모를 차례로 붙이고, 같은 메모는 한 번만", () => {
    const one = mergeEpisodeNotes({}, [
      { n: 1, progress: [a] },
      { n: 2, progress: null },
    ]);
    expect(one).toEqual({ 1: [a] });
    const two = mergeEpisodeNotes(one, [
      { n: 1, progress: [a, b] },
      { n: 2, progress: [b] },
    ]);
    expect(two).toEqual({ 1: [a, b], 2: [b] });
  });

  it("다시 쓰기로 progress가 비어도 쌓인 메모는 남고, 모양이 틀린 값은 버린다", () => {
    const prev = { 1: [a] };
    expect(mergeEpisodeNotes(prev, [{ n: 1, progress: null }])).toBe(prev);
    expect(mergeEpisodeNotes(prev, [{ n: 1, progress: [{ range: 1 }, "x", b] }])).toEqual({ 1: [a, b] });
    expect(mergeEpisodeNotes({}, [{ n: 1, progress: { range: "x", note: "y" } }])).toEqual({});
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

describe("episodeAction (편 카드의 버튼)", () => {
  it("done은 읽기, partial은 읽기 + 다시 쓰기, failed는 다시 쓰기", () => {
    expect(episodeAction("done", false)).toEqual({ read: true, retry: null });
    expect(episodeAction("partial", false)).toEqual({ read: true, retry: "button" });
    expect(episodeAction("failed", false)).toEqual({ read: false, retry: "button" });
  });

  it("정지 중이면 [다시 쓰기] 대신 마감 안내", () => {
    expect(episodeAction("failed", true)).toEqual({ read: false, retry: "paused" });
    expect(episodeAction("partial", true)).toEqual({ read: true, retry: "paused" });
  });

  it("그 밖의 상태는 버튼이 없다", () => {
    for (const s of ["queued", "running", "refused", "safety"]) expect(episodeAction(s, false, 2)).toEqual({ read: false, retry: null });
    for (const s of ["running", "refused", "safety"]) expect(episodeAction(s, false, 1)).toEqual({ read: false, retry: null });
  });

  it("1편이 queued면 [다시 쓰기]를 준다(정상 흐름은 202 전에 running이라 화면이 보는 queued 1편은 시작 전 유실이다)", () => {
    expect(episodeAction("queued", false, 1)).toEqual({ read: false, retry: "button" });
    expect(episodeAction("queued", true, 1)).toEqual({ read: false, retry: "paused" });
  });
});

describe("statCards (생각하는 동안 돌아가며 보여 줄 통계)", () => {
  const kst = (d: number, h: number, mi: number) => Date.UTC(2026, 9, d, h, mi) - 9 * 3_600_000;
  const rows: [string, number][] = [
    ["철수", kst(1, 20, 0)],
    ["민지", kst(1, 20, 4)],
    ["철수", kst(1, 23, 0)],
    ["철수", kst(2, 20, 0)],
    ["민지", kst(2, 20, 4)],
  ];
  const messages: ChatMessage[] = rows.map(([sender, ts], id) => ({ id, ts, sender, kind: "text", text: "안녕", line: id + 1 }));
  const stats = computeStats(messages);

  it("메시지 수·가장 많이 보낸 사람·최장 연속·가장 많았던 날·심야 비율·메시지 많은 두 사람의 답장 간격", () => {
    expect(statCards(stats)).toEqual([
      { label: "메시지", value: "5개" },
      { label: "가장 많이 보낸 사람", value: "철수 · 60%" },
      { label: "최장 연속", value: "2일" },
      { label: "가장 많았던 날", value: "2026-10-01 · 3개" },
      { label: "심야 비율 (22~5시)", value: "20%" },
      { label: "철수의 답장 간격", value: "2시간 56분" },
      { label: "민지의 답장 간격", value: "4분" },
    ]);
  });

  it("답장이 없는 사람·가장 많았던 날이 없으면 그 카드는 뺀다", () => {
    const one = computeStats([{ id: 0, ts: kst(1, 12, 0), sender: "철수", kind: "text", text: "안녕", line: 1 }]);
    expect(statCards({ ...one, busiestDay: null }).map((c) => c.label)).toEqual([
      "메시지",
      "가장 많이 보낸 사람",
      "최장 연속",
      "심야 비율 (22~5시)",
    ]);
  });
});
