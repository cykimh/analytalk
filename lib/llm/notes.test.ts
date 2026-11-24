import { describe, expect, it } from "vitest";
import { extractReadingNotes, salvageEpisode, sanitizeNotes } from "./notes";
import type { Episode } from "./schema";

const section = (n: number): Episode["sections"][number] => ({
  icon: "🗺️",
  title: `섹션${n}`,
  about: "pair",
  paragraphs: [
    { key: "p1", text: `${n}번째 문단. 중괄호 } 와 "따옴표", 대괄호 ] 도 든다`, evidence_ids: [`e${n}`] },
    { key: "p2", text: `${n}번째 둘째 문단 {{stat:total}}`, evidence_ids: [] },
  ],
  evidence: [{ id: `e${n}`, msg_id: `m${n}`, quote: `인용${n} \\ 역슬래시` }],
});

const EPISODE: Episode = {
  episode: 1,
  safety: { flag: "none" },
  declined_topics: ["inner_feelings"],
  reading_notes: [
    { range: "08-02~08-31", note: "저녁마다 짧게 주고받았다" },
    { range: "09-01~09-30", note: "주말 대화가 길어졌다" },
  ],
  headline: "저녁 8시의 지도",
  dek: "석 달 동안의 흐름",
  sections: [section(1), section(2), section(3)],
  next_teaser: "다음 편: 누가 먼저",
};

describe("extractReadingNotes", () => {
  it("끝나지 않은 배열에서 완결된 메모만 꺼낸다", () => {
    const partial =
      '{"episode":1,"safety":{"flag":"none"},"declined_topics":[],"reading_notes":[{"range":"08-02~08-31","note":"가"},{"range":"09';
    expect(extractReadingNotes(partial)).toEqual([{ range: "08-02~08-31", note: "가" }]);
  });

  it("들여쓰기된 JSON·완결된 응답·reading_notes 전 단계", () => {
    const pretty = JSON.stringify(EPISODE, null, 2);
    expect(extractReadingNotes(pretty)).toEqual(EPISODE.reading_notes);
    expect(extractReadingNotes(pretty.slice(0, pretty.indexOf("주말")))).toEqual([EPISODE.reading_notes[0]]);
    expect(extractReadingNotes('{"episode":1,"safety":{"flag":"none"},"declined_')).toEqual([]);
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
    expect(sanitizeNotes([{ range: "08-02~08-31", note: "속으로 좋아하는 것 같다" }])).toEqual([]);
  });

  it("코드 포인트로 센다(이모지 60개는 그대로)", () => {
    const emoji = "😀".repeat(60);
    expect(sanitizeNotes([{ range: "r", note: emoji }])[0].note).toBe(emoji);
  });

  it("배열이 아니거나 모양이 틀리거나 빈 메모는 뺀다", () => {
    expect(sanitizeNotes(null)).toEqual([]);
    expect(sanitizeNotes("메모")).toEqual([]);
    expect(sanitizeNotes([null, { range: 1, note: "가" }, { range: "r", note: "  " }, { range: " r ", note: " 나 " }])).toEqual([
      { range: "r", note: "나" },
    ]);
  });
});

describe("salvageEpisode", () => {
  const full = JSON.stringify(EPISODE);

  it("3번째 섹션 중간에서 끊기면 섹션 2개와 그 근거", () => {
    const cut = full.slice(0, full.indexOf('"title":"섹션3"') + 12);
    const r = salvageEpisode(cut);
    expect(r?.sections).toEqual([section(1), section(2)]);
    expect(r?.safety).toEqual({ flag: "none" });
    expect(r?.headline).toBe(EPISODE.headline);
    expect(r).not.toHaveProperty("next_teaser");
  });

  it("첫 섹션 근거 중간에서 끊기면 섹션 0개", () => {
    const at = full.indexOf('"quote":"인용1');
    const r = salvageEpisode(full.slice(0, at + 12));
    expect(r?.sections).toEqual([]);
    expect(r?.reading_notes).toEqual(EPISODE.reading_notes);
  });

  it("safety 전이나 safety 중간에서 끊기면 null", () => {
    expect(salvageEpisode(full.slice(0, full.indexOf('"safety"')))).toBeNull();
    expect(salvageEpisode(full.slice(0, full.indexOf('"none"') + 3))).toBeNull();
    expect(salvageEpisode("")).toBeNull();
    expect(salvageEpisode("[1,2]")).toBeNull();
    expect(salvageEpisode('{"episode":1,"safety":"none","sections":[]}')).toBeNull();
  });

  it("끝난 응답은 그대로, next_teaser 중간이면 그 필드만 빠진다", () => {
    expect(salvageEpisode(full)).toEqual(EPISODE);
    expect(salvageEpisode(JSON.stringify(EPISODE, null, 2))).toEqual(EPISODE);
    const r = salvageEpisode(full.slice(0, full.indexOf("누가")));
    expect(r?.sections).toEqual(EPISODE.sections);
    expect(r).not.toHaveProperty("next_teaser");
  });

  it("끝에 구분 글자가 없는 숫자는 완결로 보지 않는다", () => {
    expect(salvageEpisode('{"safety":{"flag":"none"},"episode":1')).toEqual({ safety: { flag: "none" } });
  });
});
