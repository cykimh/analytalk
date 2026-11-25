import { describe, expect, it } from "vitest";
import { validateEpisode } from "@/lib/llm/validate";
import type { ChatMessage } from "@/lib/parse/parse";
import { buildPayload, payloadIndex } from "@/lib/payload/build";
import { glueTails, hasStatText, MAX_STAT_TAIL, renderStatPlain, renderStatText } from "./statText";

/** KST 벽시계 → UTC epoch ms */
const kst = (d: number, h: number, mi: number) => Date.UTC(2026, 9, d, h, mi) - 9 * 3_600_000;

/**
 * 2026-10-01~03 저녁마다 철수가 묻고 민지가 정확히 4분 뒤 답한다(철수는 6시간 안에 답을 받지 못해 답장 간격이 없다).
 * 첫날만 철수가 물음표를 쓴다
 */
function fixture() {
  const rows: [string, number, string][] = [];
  for (let d = 1; d <= 3; d++) {
    rows.push(["철수", kst(d, 20, 0), d === 1 ? "오늘 뭐해?" : "오늘도 수고했어"], ["민지", kst(d, 20, 4), "집에서 쉬는 중"]);
  }
  const messages: ChatMessage[] = rows.map(([sender, ts, text], id) => ({ id, ts, sender, kind: "text", text, line: id + 1 }));
  const p = buildPayload({ messages, me: "민지", concept: "couple", kind: "pair", tokenBudget: 1_000_000, tokensPerChar: 1 });
  return { idx: payloadIndex(p), stats: p.stats };
}
const { idx, stats } = fixture();

describe("renderStatText", () => {
  it("자리표시자를 통계 값으로 채운다: ms → N분", () => {
    expect(renderStatText("답장 {{stat:replyMedianMs.민지}}", stats)).toEqual([
      "답장 ",
      { path: "replyMedianMs.민지", display: "4분" },
    ]);
  });

  it("단위별 포맷: ratio → N%, days → N일, count → 숫자", () => {
    expect(stats.questionRate.철수).toBeCloseTo(1 / 3);
    expect(renderStatText("{{stat:questionRate.철수}}·{{stat:longestStreakDays}}·{{stat:total}}개", stats)).toEqual([
      { path: "questionRate.철수", display: "33%" },
      "·",
      { path: "longestStreakDays", display: "3일" },
      "·",
      { path: "total", display: "6" },
      "개",
    ]);
  });

  it("모르는 경로·값이 없는 경로·stat이 아닌 자리표시자는 빼고 글자만 남긴다(이웃 글자는 하나로 잇는다)", () => {
    expect(renderStatText("답장 {{stat:nope.민지}} 빨라요", stats)).toEqual(["답장  빨라요"]);
    // 철수는 답장을 받은 적이 없어 replyMedianMs가 null이다
    expect(renderStatText("철수는 {{stat:replyMedianMs.철수}}", stats)).toEqual(["철수는 "]);
    expect(renderStatText("{{name}}님 {{stat:total}}", stats)).toEqual(["님 ", { path: "total", display: "6" }]);
    expect(renderStatText("{{stat:nope}}", stats)).toEqual([]);
  });

  it("자리표시자가 없으면 글자 그대로, 빈 글은 빈 배열", () => {
    expect(renderStatText("저녁마다 짧게 주고받았어요", stats)).toEqual(["저녁마다 짧게 주고받았어요"]);
    expect(renderStatText("", stats)).toEqual([]);
  });

  it("monthly.2026-10.replyMedianMs.민지는 validateEpisode가 남긴 문단에서 같은 값으로 풀린다", () => {
    const path = "monthly.2026-10.replyMedianMs.민지";
    const text = `민지의 10월 답장 간격은 {{stat:${path}}}였어요`;
    const r = validateEpisode(
      {
        episode: 1,
        safety: { flag: "none" },
        declined_topics: [],
        reading_notes: [],
        headline: "저녁 8시",
        dek: "사흘",
        sections: [
          {
            icon: "🌙",
            title: "답장",
            about: "pair",
            paragraphs: [
              { key: "p1", text, evidence_ids: [] },
              { key: "p2", text: "민지는 {{stat:monthly.2026-09.replyMedianMs.민지}}", evidence_ids: [] },
            ],
            evidence: [],
          },
        ],
        next_teaser: null,
      },
      idx,
      stats,
      { truncated: false },
    );
    // 9월은 없어서 validateEpisode가 지우고, renderStatText도 그 자리를 빼고 보여 준다
    expect(r.content?.sections[0].paragraphs.map((p) => p.text)).toEqual([text]);
    expect(renderStatText("민지는 {{stat:monthly.2026-09.replyMedianMs.민지}}", stats)).toEqual(["민지는 "]);
    expect(renderStatText(r.content!.sections[0].paragraphs[0].text, stats)).toEqual([
      "민지의 10월 답장 간격은 ",
      { path, display: "4분" },
      "였어요",
    ]);
  });
});

describe("renderStatPlain", () => {
  it("헤드라인처럼 문자열이 필요한 곳: 채운 값을 이어 붙인 글자", () => {
    expect(renderStatPlain("민지의 {{stat:replyMedianMs.민지}} 법칙", stats)).toBe("민지의 4분 법칙");
    expect(renderStatPlain("{{stat:longestStreakDays}} 동안 {{stat:total}}개", stats)).toBe("3일 동안 6개");
  });

  it("화면이 붙이는 단위를 모델이 한 번 더 써도 겹치지 않는다(%·일·분/시간/밀리초)", () => {
    expect(renderStatPlain("질문 {{stat:questionRate.철수}}%", stats)).toBe("질문 33%");
    expect(renderStatPlain("{{stat:questionRate.철수}}퍼센트", stats)).toBe("33%");
    expect(renderStatPlain("{{stat:longestStreakDays}}일 연속", stats)).toBe("3일 연속");
    expect(renderStatPlain("{{stat:replyMedianMs.민지}}분 만에", stats)).toBe("4분 만에");
    expect(renderStatPlain("{{stat:replyMedianMs.민지}}밀리초", stats)).toBe("4분");
    // 띄어 쓴 다음 말과 셀 단위가 없는 count는 그대로 둔다
    expect(renderStatPlain("{{stat:longestStreakDays}} 일찍", stats)).toBe("3일 일찍");
    expect(renderStatPlain("{{stat:total}}일", stats)).toBe("6일");
  });

  it("count 값은 소수 한 자리까지(avgLen 12.3456 → 12.3)", () => {
    const withLen = { ...stats, monthly: { "2026-10": { ...stats.monthly["2026-10"], avgLen: { 민지: 12.3456 } } } } as typeof stats;
    expect(renderStatPlain("{{stat:monthly.2026-10.avgLen.민지}}자", withLen)).toBe("12.3자");
  });

  it("풀리지 않는 자리표시자는 빼고, 자리표시자가 없으면 글자 그대로", () => {
    expect(renderStatPlain("{{stat:nope}}의 {{name}} 법칙", stats)).toBe("의  법칙");
    expect(renderStatPlain("저녁의 리듬", stats)).toBe("저녁의 리듬");
    expect(renderStatPlain("", stats)).toBe("");
  });
});

describe("hasStatText", () => {
  it("채운 뒤 보일 글자가 남는지(없으면 화면이 기본 제목을 쓰거나 줄을 숨긴다)", () => {
    expect(hasStatText("{{stat:total}}개", stats)).toBe(true);
    expect(hasStatText("{{stat:total}}", stats)).toBe(true);
    expect(hasStatText("{{stat:nope}} {{stat:replyMedianMs.철수}}", stats)).toBe(false);
    expect(hasStatText("  ", stats)).toBe(false);
    expect(hasStatText(null, stats)).toBe(false);
  });
});

describe("glueTails", () => {
  const pct = { path: "questionRate.철수", display: "23%" };
  const min = { path: "replyMedianMs.민지", display: "4분" };

  it("값 바로 뒤에 붙은 조사·문장부호를 값과 한 조각으로 묶고, 나머지 글은 그대로 둔다", () => {
    expect(glueTails(["물음표 비율은 ", pct, "로, 궁금한 건 바로"])).toEqual([
      "물음표 비율은 ",
      { ...pct, tail: "로," },
      " 궁금한 건 바로",
    ]);
    // 뒤 글이 통째로 붙은 말이면 남는 글 조각이 없다
    expect(glueTails([pct, "예요."])).toEqual([{ ...pct, tail: "예요." }]);
  });

  it("띄어 쓴 뒤 글·글이 없는 끝·이어지는 값은 묶지 않는다", () => {
    expect(glueTails(["답장 ", min, " 안에"])).toEqual(["답장 ", { ...min, tail: "" }, " 안에"]);
    expect(glueTails(["답장 ", min])).toEqual(["답장 ", { ...min, tail: "" }]);
    expect(glueTails([min, "~", pct])).toEqual([{ ...min, tail: "~" }, { ...pct, tail: "" }]);
  });

  it("붙은 말이 길면(띄어 쓰지 않은 긴 글) 375px에서 넘치지 않게 묶지 않는다", () => {
    const long = "가".repeat(MAX_STAT_TAIL + 1);
    expect(glueTails([pct, long])).toEqual([{ ...pct, tail: "" }, long]);
    const edge = "가".repeat(MAX_STAT_TAIL);
    expect(glueTails([pct, edge])).toEqual([{ ...pct, tail: edge }]);
  });

  it("묶어도 이어 붙인 글자는 renderStatPlain과 같다", () => {
    const text = "질문 {{stat:questionRate.철수}}%로, 답장은 {{stat:replyMedianMs.민지}} 만에";
    const joined = glueTails(renderStatText(text, stats))
      .map((t) => (typeof t === "string" ? t : t.display + t.tail))
      .join("");
    expect(joined).toBe(renderStatPlain(text, stats));
  });
});
