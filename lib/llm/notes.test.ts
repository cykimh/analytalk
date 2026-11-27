import { describe, expect, it } from "vitest";
import { extractReadingNotes, salvageReport, sanitizeNotes } from "./notes";
import type { Report } from "./schema";

const PARTS = ["map", "first", "shift", "letter"];
const section = (n: number): Report["sections"][number] => ({
  part: PARTS[n - 1],
  icon: "🗺️",
  title: `섹션${n}`,
  about: "pair",
  paragraphs: [
    { key: "p1", text: `${n}번째 문단. 중괄호 } 와 "따옴표", 대괄호 ] 도 든다`, evidence_ids: [`e${n}`] },
    { key: "p2", text: `${n}번째 둘째 문단 {{stat:total}}`, evidence_ids: [] },
  ],
  evidence: [{ id: `e${n}`, msg_id: `m${n}`, quote: `인용${n} \\ 역슬래시` }],
  mbti: "",
  mbti_reason: "",
  persona: null,
});

const REPORT: Report = {
  safety: { flag: "none" },
  declined_topics: ["hate"],
  reading_notes: [
    { range: "08-02~08-31", note: "저녁마다 짧게 주고받았다" },
    { range: "09-01~09-30", note: "주말 대화가 길어졌다" },
  ],
  headline: "저녁 8시의 지도",
  dek: "석 달 동안의 흐름",
  chemistry: { score: 73, line: "석 달 내내 저녁 8시에 모인 {둘}" },
  relationship: { one_line: "저녁 8시의 [단짝]", to_each_other: "서로의 \"마침표\"", inside_jokes: ["}", "]"], conflict: "" },
  sections: [section(1), section(2), section(3), section(4)],
};

describe("extractReadingNotes", () => {
  it("끝나지 않은 배열에서 완결된 메모만 꺼낸다", () => {
    const partial =
      '{"safety":{"flag":"none"},"declined_topics":[],"reading_notes":[{"range":"08-02~08-31","note":"가"},{"range":"09';
    expect(extractReadingNotes(partial)).toEqual([{ range: "08-02~08-31", note: "가" }]);
  });

  it("들여쓰기된 JSON·완결된 응답·reading_notes 전 단계", () => {
    const pretty = JSON.stringify(REPORT, null, 2);
    expect(extractReadingNotes(pretty)).toEqual(REPORT.reading_notes);
    expect(extractReadingNotes(pretty.slice(0, pretty.indexOf("주말")))).toEqual([REPORT.reading_notes[0]]);
    expect(extractReadingNotes('{"safety":{"flag":"none"},"declined_')).toEqual([]);
    expect(extractReadingNotes("")).toEqual([]);
    expect(extractReadingNotes("not json")).toEqual([]);
  });

  it("모양이 틀린 메모는 뺀다", () => {
    const partial = '{"reading_notes":[{"range":"08-02","note":3},"글자",{"range":"08-03","note":"나"}';
    expect(extractReadingNotes(partial)).toEqual([{ range: "08-03", note: "나" }]);
  });
});

describe("sanitizeNotes", () => {
  it("메모를 60자로 자르고 금지 표현이 든 메모는 뺀다", () => {
    const long = "가".repeat(61);
    expect(sanitizeNotes([{ range: "08-02~08-31", note: long }])).toEqual([{ range: "08-02~08-31", note: "가".repeat(60) }]);
    expect(sanitizeNotes([{ range: "08-02~08-31", note: "그냥 죽어 버려라" }])).toEqual([]);
  });

  it("코드 포인트로 센다(이모지 60개는 그대로)", () => {
    const emoji = "😀".repeat(60);
    expect(sanitizeNotes([{ range: "10-01", note: emoji }])[0].note).toBe(emoji);
  });

  it("배열이 아니거나 모양이 틀리거나 빈 메모는 뺀다", () => {
    expect(sanitizeNotes(null)).toEqual([]);
    expect(sanitizeNotes("메모")).toEqual([]);
    expect(sanitizeNotes([null, { range: 1, note: "가" }, { range: "10-01", note: "  " }, { range: " 10-01 ", note: " 나 " }])).toEqual([
      { range: "10-01", note: "나" },
    ]);
  });

  it("range는 MM-DD 또는 MM-DD~MM-DD만 받는다(앞의 연도·띄어쓰기는 정리, 그 밖은 비운다)", () => {
    const notes = [
      { range: "10-01 ~ 10-03", note: "가" },
      { range: "2026-10-01~2026-10-03", note: "나" },
      { range: "x".repeat(299), note: "다" },
      { range: "10월 초", note: "라" },
    ];
    expect(sanitizeNotes(notes).map((n) => n.range)).toEqual(["10-01~10-03", "10-01~10-03", "", ""]);
  });

  it("개인정보가 든 메모는 빼고, 메모는 20개까지", () => {
    expect(sanitizeNotes([{ range: "10-01", note: "010-1234-5678로 연락" }])).toEqual([]);
    const many = Array.from({ length: 25 }, (_, i) => ({ range: "10-01", note: `메모 ${i}` }));
    expect(sanitizeNotes(many)).toHaveLength(20);
  });
});

describe("salvageReport", () => {
  const full = JSON.stringify(REPORT);

  it("4번째 섹션(편지) 가운데서 끊기면 앞 3개 섹션과 그 근거", () => {
    const cut = full.slice(0, full.indexOf('"title":"섹션4"') + 12);
    const r = salvageReport(cut);
    expect(r?.sections).toEqual([section(1), section(2), section(3)]);
    expect(r?.sections?.map((s) => s.part)).toEqual(["map", "first", "shift"]);
    expect(r?.sections?.[2].evidence).toEqual([{ id: "e3", msg_id: "m3", quote: "인용3 \\ 역슬래시" }]);
    expect(r?.safety).toEqual({ flag: "none" });
    expect(r?.headline).toBe(REPORT.headline);
  });

  it("v2.8: 케미 온도는 섹션 앞이라 섹션 가운데서 끊겨도 남는다", () => {
    const r = salvageReport(full.slice(0, full.indexOf('"title":"섹션2"')));
    expect(r?.chemistry).toEqual(REPORT.chemistry);
    expect(r?.sections).toEqual([section(1)]);
  });

  it("첫 섹션 근거 중간에서 끊기면 섹션 0개", () => {
    const at = full.indexOf('"quote":"인용1');
    const r = salvageReport(full.slice(0, at + 12));
    expect(r?.sections).toEqual([]);
    expect(r?.reading_notes).toEqual(REPORT.reading_notes);
  });

  it("safety 전이나 safety 중간에서 끊기면 null", () => {
    expect(salvageReport(full.slice(0, full.indexOf('"safety"')))).toBeNull();
    expect(salvageReport(full.slice(0, full.indexOf('"none"') + 3))).toBeNull();
    expect(salvageReport("")).toBeNull();
    expect(salvageReport("[1,2]")).toBeNull();
    expect(salvageReport('{"safety":"none","sections":[]}')).toBeNull();
  });

  it("끝난 응답은 그대로, dek 중간이면 dek와 그 뒤가 빠진다", () => {
    expect(salvageReport(full)).toEqual(REPORT);
    expect(salvageReport(JSON.stringify(REPORT, null, 2))).toEqual(REPORT);
    const r = salvageReport(full.slice(0, full.indexOf("동안의")));
    expect(r?.headline).toBe(REPORT.headline);
    expect(r).not.toHaveProperty("dek");
    expect(r).not.toHaveProperty("sections");
  });

  it("끝에 구분 글자가 없는 숫자는 완결로 보지 않는다", () => {
    expect(salvageReport('{"safety":{"flag":"none"},"count":1')).toEqual({ safety: { flag: "none" } });
  });
});
