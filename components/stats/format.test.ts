import { describe, expect, it } from "vitest";
import type { ChatStats } from "@/lib/stats/compute";
import { crossedText, formatCount, formatDuration, formatPercent, heatmapRows, heatLevel, kstDate, topPeople } from "./format";

describe("포맷", () => {
  it("formatDuration: 분·시간·일, null은 -", () => {
    expect(formatDuration(30_000)).toBe("1분 미만");
    expect(formatDuration(4 * 60_000)).toBe("4분");
    expect(formatDuration(90 * 60_000)).toBe("1시간 30분");
    expect(formatDuration(120 * 60_000)).toBe("2시간");
    expect(formatDuration(26 * 3_600_000)).toBe("1일 2시간");
    expect(formatDuration(59.7 * 60_000)).toBe("1시간");
    expect(formatDuration(23.995 * 3_600_000)).toBe("1일");
    expect(formatDuration(null)).toBe("-");
  });

  it("formatPercent·formatCount·kstDate", () => {
    expect(formatPercent(0.0912)).toBe("9%");
    expect(formatPercent(1)).toBe("100%");
    expect(formatCount(6240)).toBe("6,240");
    expect(kstDate(Date.UTC(2024, 2, 13, 15, 5))).toBe("2024-03-14");
  });
});

describe("topPeople", () => {
  it("메시지 많은 순(동률은 이름 순)으로 n명과 나머지 수", () => {
    const stats = { byPerson: { 다: 5, 가: 5, 나: 9, 라: 1 } } as unknown as ChatStats;
    expect(topPeople(stats, 2)).toEqual({ people: ["나", "가"], rest: 2 });
    expect(topPeople(stats, 10)).toEqual({ people: ["나", "가", "다", "라"], rest: 0 });
  });
});

describe("heatmapRows", () => {
  it("첫 달부터 마지막 달까지 달마다 31칸. 없는 날은 null, 메시지 없는 날은 0", () => {
    expect(heatmapRows({ "2023-11-02": 1, "2024-02-01": 1 }).map((r) => r.month)).toEqual(["2023-11", "2023-12", "2024-01", "2024-02"]);
    const rows = heatmapRows({ "2024-01-31": 3, "2024-03-01": 1 });
    expect(rows.map((r) => r.month)).toEqual(["2024-01", "2024-02", "2024-03"]);
    expect(rows[0].days[30]).toBe(3);
    expect(rows[0].days[0]).toBe(0);
    expect(rows[1].days.slice(28)).toEqual([0, null, null]);
    expect(rows[2].days[0]).toBe(1);
    expect(rows.every((r) => r.days.length === 31)).toBe(true);
    expect(heatmapRows({})).toEqual([]);
  });

  it("heatLevel: 0은 0, 나머지는 최댓값 대비 1~4", () => {
    expect([0, 1, 25, 50, 75, 100].map((n) => heatLevel(n, 100))).toEqual([0, 1, 1, 2, 3, 4]);
  });
});

describe("crossedText", () => {
  it("오른 지표와 내린 지표를 묘사만 한다", () => {
    expect(crossedText({ month: "2026-10", person: "P1", up: "replySpeed", down: "questionRate", upPct: 32.4, downPct: -40.2 })).toBe(
      "답장이 32% 빨라졌는데 질문은 40% 줄었어요",
    );
    expect(crossedText({ month: "2026-10", person: "P1", up: "avgLen", down: "count", upPct: 20, downPct: -25 })).toBe(
      "메시지가 20% 길어졌는데 메시지 수는 25% 줄었어요",
    );
  });
});
