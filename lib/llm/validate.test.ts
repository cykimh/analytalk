import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/lib/parse/parse";
import { buildPayload, payloadIndex } from "@/lib/payload/build";
import { resolveStat } from "@/lib/stats/paths";
import { memberCodes } from "@/lib/payload/build";
import type { Tone } from "./concepts";
import type { Report } from "./schema";
import { RELINK_NEAR, validateReport } from "./validate";

/** KST 벽시계 → UTC epoch ms */
const kst = (d: number, h: number, mi: number) => Date.UTC(2026, 9, d, h, mi) - 9 * 3_600_000;

/** 2026-10-01~03 저녁마다 철수·민지(표시 이름)가 네 번 주고받는 대화. id는 0부터, 하루 4개 */
function fixture(other = "철수", me = "민지") {
  const rows: [string, number, string][] = [];
  for (let d = 1; d <= 3; d++) {
    rows.push(
      [other, kst(d, 20, 0), "오늘 뭐해?"],
      [me, kst(d, 20, 5), "집에서 쉬는 중 ㅋㅋ"],
      [other, kst(d, 20, 6), "영화 볼래?\n내일 저녁"],
      [me, kst(d, 20, 10), "좋아!"],
    );
  }
  const messages: ChatMessage[] = rows.map(([sender, ts, text], id) => ({ id, ts, sender, kind: "text", text, line: id + 1 }));
  const p = buildPayload({ messages, tone: "fact", concept: "couple", kind: "pair", tokenBudget: 1_000_000, tokensPerChar: 1 });
  return { idx: payloadIndex(p), stats: p.stats, members: p.members };
}
const { idx, stats, members } = fixture();

type Section = Report["sections"][number];
type Paragraph = Section["paragraphs"][number];
const para = (key: string, text: string, evidence_ids: string[] = []): Paragraph => ({ key, text, evidence_ids });
const ev = (id: string, msg_id: string, quote: string) => ({ id, msg_id, quote });
const sec = (title: string, paragraphs: Paragraph[], evidence: Section["evidence"] = [], about = "pair", part = "nag_room"): Section => ({
  part,
  icon: "🌙",
  title,
  about,
  paragraphs,
  evidence,
  mbti: "",
  mbti_reason: "",
});
const report = (sections: Section[], extra: Partial<Report> = {}): Report => ({
  safety: { flag: "none" },
  declined_topics: [],
  reading_notes: [{ range: "10-01~10-03", note: "사흘 동안 저녁마다 이야기했다" }],
  headline: "저녁 8시의 대화",
  dek: "사흘 동안의 흐름",
  chemistry: null,
  sections,
  ...extra,
});
const run = (raw: unknown, truncated = false, tone: Tone = "fact") =>
  validateReport(raw, idx, stats, { truncated, tone, members });

describe("validateReport", () => {
  it("정상이면 done이고 근거에 sender·at이 채워진다", () => {
    const raw = report([
      sec("저녁의 리듬", [para("p1", "민지는 저녁마다 짧게 답했어요", ["e1"])], [ev("e1", "m1", "쉬는 중")]),
    ]);
    const r = run(raw);
    expect(r.status).toBe("done");
    expect(r.dropped).toMatchObject({ paragraphs: 0, evidence: 0 });
    expect(r.content?.sections[0].evidence).toEqual([
      { id: "e1", msg_id: "m1", quote: "쉬는 중", sender: "민지", at: "2026-10-01T20:05:00+09:00" },
    ]);
    expect(r.content?.headline).toBe("저녁 8시의 대화");
    expect(r.content?.reading_notes).toEqual(raw.reading_notes);
  });

  it("없는 msg_id·본문과 다른 quote·빈 quote는 근거에서 지운다", () => {
    const r = run(
      report([
        sec(
          "근거 검사",
          [para("p1", "저녁에 대화가 몰려요", ["e1", "e2", "e3", "e4"])],
          [ev("e1", "m999", "쉬는 중"), ev("e2", "m1", "학교에서"), ev("e3", "m1", " "), ev("e4", "m1", "집에서")],
        ),
      ]),
    );
    expect(r.content?.sections[0].evidence.map((e) => e.id)).toEqual(["e4"]);
    expect(r.content?.sections[0].paragraphs[0].evidence_ids).toEqual(["e4"]);
    expect(r.dropped).toMatchObject({ paragraphs: 0, evidence: 3 });
  });

  it("줄바꿈(⏎)이 든 본문은 줄바꿈으로 비교하고 저장한다", () => {
    const r = run(
      report([
        sec(
          "영화",
          [para("p1", "철수가 영화를 제안했어요", ["e1", "e2"])],
          [ev("e1", "m2", "영화 볼래?\n내일"), ev("e2", "m6", "볼래? ⏎ 내일 저녁")],
        ),
      ]),
    );
    expect(r.content?.sections[0].evidence.map((e) => e.quote)).toEqual(["영화 볼래?\n내일", "볼래?\n내일 저녁"]);
  });

  it("금지 문장이 든 문단은 지운다", () => {
    const r = run(
      report([
        sec("마음", [para("p1", "저녁에 대화가 몰려요"), para("p2", "철수는 게이가 분명해요"), para("p3", "주말엔 조용해요")]),
      ]),
    );
    expect(r.content?.sections[0].paragraphs.map((p) => p.text)).toEqual(["저녁에 대화가 몰려요", "주말엔 조용해요"]);
    expect(r.dropped.paragraphs).toBe(1);
    expect(r.status).toBe("partial"); // 3개 중 1개 = 33%
  });

  it("10개 중 4개가 지워지면 partial", () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) =>
      para(`p${i + 1}`, i < 4 ? `그냥 죽어 버려라 ${i}` : `저녁 대화가 이어져요 ${i}`),
    );
    const r = run(report([sec("열 문단", paragraphs)]));
    expect(r.status).toBe("partial");
    expect(r.dropped.paragraphs).toBe(4);
    expect(r.content?.sections[0].paragraphs).toHaveLength(6);
  });

  it("10개 중 2개만 지워지면 done", () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) =>
      para(`p${i + 1}`, i < 2 ? `여자라서 그래요 ${i}` : `저녁 대화가 이어져요 ${i}`),
    );
    expect(run(report([sec("열 문단", paragraphs)])).status).toBe("done");
  });

  it("{{stat:경로}}: 풀리는 경로는 유지, 없는 경로·모르는 자리표시자는 문단 제거", () => {
    expect(resolveStat("monthly.2026-10.replyMedianMs.민지", stats)).not.toBeNull();
    const r = run(
      report([
        sec("숫자", [
          para("p1", "민지의 10월 답장 간격은 {{stat:monthly.2026-10.replyMedianMs.민지}}였어요"),
          para("p2", "민지의 9월 답장 간격은 {{stat:monthly.2026-09.replyMedianMs.민지}}였어요"),
          para("p3", "대화는 모두 {{stat:total}}개예요 {{name}}"),
          para("p4", "철수는 {{stat:byPerson.영희}}개"),
        ]),
      ]),
    );
    expect(r.content?.sections[0].paragraphs.map((p) => p.key)).toEqual(["p1"]);
  });

  // v2.2: 사람 근거는 섹션 단위다. 사람을 다루는 섹션에 남은 근거 인용이나 풀리는 자리표시자가 하나라도 있으면 된다
  it("사람 섹션에 남은 근거 인용이 하나라도 있으면 근거를 달지 않은 사람 문단도 남는다", () => {
    const r = run(
      report([
        sec(
          "민지",
          [
            para("p1", "민지는 저녁마다 짧게 답했어요"),
            para("p2", "웃음이 많아요", ["e1"]),
            para("p3", "대답보다 질문이 먼저 나오는 날도 있었어요"),
          ],
          [ev("e1", "m1", "ㅋㅋ")],
          "민지",
        ),
      ]),
    );
    expect(r.status).toBe("done");
    expect(r.content?.sections[0].paragraphs.map((p) => [p.key, p.evidence_ids])).toEqual([
      ["p1", []],
      ["p2", ["e1"]],
      ["p3", []],
    ]);
  });

  // v2.5: 근거를 달았는데 원문과 맞는 것이 하나도 없는 문단도 남긴다(근거 id만 빠진다). v2.2 Fix 1까지는 지웠다
  it("원문과 맞는 근거가 하나도 없는 문단(가짜 근거만 단 문단)도 남고 근거 id만 빠진다", () => {
    const r = run(
      report([
        sec(
          "근거",
          [
            para("p1", "철수는 늘 먼저 물었어요", ["e1"]),
            para("p2", "저녁 8시에 대화가 몰려요", ["e1"]),
            para("p3", "민지의 답은 짧고 빨랐어요", ["e2"]),
            para("p4", "민지는 웃음이 많아요", ["e1", "e2"]),
          ],
          [ev("e1", "m999", "없는 메시지"), ev("e2", "m3", "좋아!")],
        ),
      ]),
    );
    expect(r.content?.sections[0].paragraphs.map((p) => [p.key, p.text, p.evidence_ids])).toEqual([
      ["p1", "철수는 늘 먼저 물었어요", []],
      ["p2", "저녁 8시에 대화가 몰려요", []],
      ["p3", "민지의 답은 짧고 빨랐어요", ["e2"]],
      ["p4", "민지는 웃음이 많아요", ["e2"]],
    ]);
    expect(r.content?.sections[0].evidence.map((e) => e.id)).toEqual(["e2"]);
    expect(r.dropped).toMatchObject({ paragraphs: 0, evidence: 1 });
    expect(r.status).toBe("done");
  });

  it("v2.5: 문단 안 큰따옴표 인용이 원문과 안 맞으면 문단은 남기고 그 따옴표만 뗀다(제목·headline·dek도)", () => {
    const r = run(
      report([
        sec(
          "민지",
          [
            para("p1", "민지는 \"집에서 쉬는 중\"이라고 답했어요", ["e1"]),
            para("p2", "철수는 “영화 볼래? ⏎ 내일 저녁”이라고 물었어요"),
            para("p3", "민지는 \"나는 철수가 제일 좋아\"라고 했어요", ["e1"]),
            para("p4", "철수는 “내일 꼭 만나자”라고 했어요"),
            para("p5", "답은 늘 \"좋아\"였고, 별명은 '저녁 8시 담당'이에요"),
          ],
          [ev("e1", "m1", "쉬는 중")],
          "민지",
        ),
      ], { headline: "\"철수 사랑해\"의 방", dek: "\"오늘 뭐해?\"로 시작하는 저녁" }),
    );
    expect(r.content?.sections[0].paragraphs.map((p) => p.text)).toEqual([
      "민지는 \"집에서 쉬는 중\"이라고 답했어요",
      "철수는 “영화 볼래? ⏎ 내일 저녁”이라고 물었어요",
      "민지는 나는 철수가 제일 좋아라고 했어요",
      "철수는 내일 꼭 만나자라고 했어요",
      "답은 늘 \"좋아\"였고, 별명은 '저녁 8시 담당'이에요",
    ]);
    expect(r.dropped.paragraphs).toBe(0);
    expect(r.status).toBe("done");
    // 제목·headline·dek의 지어낸 인용도 따옴표만 뗀다
    expect(r.content?.headline).toBe("철수 사랑해의 방");
    expect(r.content?.dek).toBe("\"오늘 뭐해?\"로 시작하는 저녁");
    expect(r.content?.checks).toMatchObject({ unquoted: 3, dropped_by: {} });
  });

  it("Fix 2: 작은따옴표+토씨('…'라고)·둥근 작은따옴표·낫표·겹낫표 인용도 원문과 대 본다. 토씨 없는 별명과 '…'이라고 부르는 별명은 남는다", () => {
    const texts = [
      "민지는 '나 철수 진짜 싫어'라고 했다.",
      "민지는 ‘나 철수 진짜 싫어’라고 했다.",
      "민지는 「나 철수 진짜 싫어」라고 했다.",
      "민지는 『나 철수 진짜 싫어』라고 했다.",
      "민지는 '나 철수 진짜 싫어' 하고 웃었다.",
      "민지는 '싫어'이라며 돌아섰다.",
      // 원문에 있는 말은 따옴표 모양과 상관없이 남는다
      "민지는 '집에서 쉬는 중'이라고 답했다.",
      "민지는 ‘쉬는 중’이라고 답했다.",
      "민지는 「좋아!」 하고 답했다.",
      // 토씨 없는 작은따옴표는 별명·상 이름이다
      "민지의 별명은 '저녁 8시 담당'이고 '심야 라디오상' 수상자다.",
      "그래서 민지는 '선톡왕'이라고 불린다.",
    ];
    const r = run(report([sec("민지", texts.map((t, i) => para(`p${i + 1}`, t, ["e1"])), [ev("e1", "m1", "쉬는 중")], "민지")]));
    expect(r.status).toBe("done");
    // 원문과 안 맞는 여섯은 따옴표 문자만 떼어 서술로 남는다
    expect(r.content?.sections[0].paragraphs.map((p) => p.text)).toEqual([
      "민지는 나 철수 진짜 싫어라고 했다.",
      "민지는 나 철수 진짜 싫어라고 했다.",
      "민지는 나 철수 진짜 싫어라고 했다.",
      "민지는 나 철수 진짜 싫어라고 했다.",
      "민지는 나 철수 진짜 싫어 하고 웃었다.",
      "민지는 싫어이라며 돌아섰다.",
      ...texts.slice(6),
    ]);
    expect(r.dropped.paragraphs).toBe(0);
    expect(r.content?.checks?.unquoted).toBe(6);
  });

  it("Fix 2: 인용 길이 하한이 없다. 지어낸 짧은 말(\"사랑해\"·\"싫어\")은 따옴표를 떼고 원문에 있는 짧은 말(\"좋아\"·\"ㅋㅋ\")은 그대로. 빈 따옴표는 건너뛴다", () => {
    const texts = [
      "민지는 \"사랑해\"라고 했다.",
      "민지는 \"싫어\"라고 했다.",
      "민지는 \"좋아\"라고 했다.",
      "민지는 \"ㅋㅋ\"로 답했다.",
      "철수의 빈 말풍선 \" \"도 있었다.",
    ];
    const r = run(report([sec("민지", texts.map((t, i) => para(`p${i + 1}`, t, ["e1"])), [ev("e1", "m1", "쉬는 중")], "민지")], { dek: "\"미안해\"가 없는 방" }));
    expect(r.content?.sections[0].paragraphs.map((p) => p.text)).toEqual(["민지는 사랑해라고 했다.", "민지는 싫어라고 했다.", ...texts.slice(2)]);
    expect(r.content?.dek).toBe("미안해가 없는 방");
  });

  it("Fix 3: '…' 뒤의 라는·란·라던·라 했다·고 했다·했다·면서, 캐치프레이즈는 '…'다, 《…》·〈…〉·＂…＂도 인용이다. 부르다·불리다 밖의 부·불 동사는 빼 주지 않는다", () => {
    const fake = "나 철수 진짜 싫어";
    const dropped = [
      `민지는 '${fake}'라는 말을 남겼다.`,
      `민지는 '${fake}'란 말만 했다.`,
      `민지가 '${fake}'라던 그날이었다.`,
      `민지는 '${fake}'라 했다.`,
      `민지는 '${fake}'고 했다.`,
      `민지는 '${fake}' 했다.`,
      `민지는 '${fake}'면서 웃었다.`,
      `민지는 '${fake}'라고 부탁했다.`,
      `민지는 '${fake}'라고 불평했다.`,
      `민지의 캐치프레이즈는 '${fake}'다.`,
      `민지는 《${fake}》라고 했다.`,
      `민지는 〈${fake}〉라고 했다.`,
      `민지는 ＂${fake}＂라고 했다.`,
    ];
    const kept = [
      "그래서 민지는 '선톡왕'이라고 불린다.",
      "민지는 '선톡왕'이라 불린다.",
      "민지에게는 '선톡왕'이라는 별명이 붙었다.",
      "민지는 '선톡왕'이라서 늘 먼저 말을 건다.",
      "민지는 '선톡왕'과 '심야 라디오상'을 받았다.",
      "MC는 이 장면을 '대답 대신 증거 제출'이라고 이름 붙였다.",
      "민지는 '집에서 쉬는 중'이라는 말로 답했다.",
      "민지의 말버릇은 '좋아!'다.",
    ];
    const texts = [...dropped, ...kept];
    const r = run(report([sec("민지", texts.map((t, i) => para(`p${i + 1}`, t, ["e1"])), [ev("e1", "m1", "쉬는 중")], "민지")]));
    // 인용으로 본 '…'·《…》 등은 원문과 안 맞아 따옴표만 떼어지고, 별명·이름 붙이기와 원문에 있는 말은 그대로다
    const unquoted = (t: string) => t.replace(/['《》〈〉＂]/g, "");
    expect(r.content?.sections[0].paragraphs.map((p) => p.text)).toEqual([...dropped.map(unquoted), ...kept]);
    expect(r.dropped.paragraphs).toBe(0);
    expect(r.content?.checks?.unquoted).toBe(dropped.length);
  });

  it("Fix 3: 인용이 든 문장에 멤버 이름이 나오면 그 멤버가 보낸 말이어야 한다. 이름이 없으면 누구의 말이든 원문에 있으면 된다", () => {
    const texts = [
      // 민지가 보낸 말을 철수의 말로 옮겼다
      "철수는 \"집에서 쉬는 중\"이라고 했다.",
      "민지는 \"영화 볼래?\"라고 물었다.",
      "철수의 캐치프레이즈는 '좋아!'다.",
      // 말한 사람이 맞다
      "민지는 \"집에서 쉬는 중\"이라고 했다.",
      "철수는 \"영화 볼래?\"라고 물었다.",
      // 한 문장에 두 사람: 둘 중 누구의 말이든 된다
      "철수가 \"오늘 뭐해?\"라고 묻자 민지는 \"좋아!\"라고 답했다.",
      // 듣는 사람(에게·를)으로만 나온 이름은 말한 사람으로 보지 않는다
      "철수에게 돌아온 답은 \"좋아!\"였다.",
      // 인용 속 이름·물음표는 말한 사람·문장 경계가 아니다
      "저녁마다 \"오늘 뭐해?\"가 온다. 그다음은 늘 민지 차례다.",
    ];
    const r = run(
      report([sec("민지", texts.map((t, i) => para(`p${i + 1}`, t, ["e1"])), [ev("e1", "m1", "쉬는 중")], "민지")], {
        headline: "민지의 \"오늘 뭐해?\"",
        dek: "철수의 \"오늘 뭐해?\"로 여는 저녁",
      }),
    );
    expect(r.content?.sections[0].paragraphs.map((p) => p.text)).toEqual([
      "철수는 집에서 쉬는 중이라고 했다.",
      "민지는 영화 볼래?라고 물었다.",
      "철수의 캐치프레이즈는 좋아!다.",
      ...texts.slice(3),
    ]);
    expect(r.dropped.paragraphs).toBe(0);
    expect(r.content?.headline).toBe("민지의 오늘 뭐해?");
    expect(r.content?.dek).toBe("철수의 \"오늘 뭐해?\"로 여는 저녁");
  });

  it("자리표시자만 있는 사람 섹션도 남는다(섹션 어디든 하나)", () => {
    const r = run(
      report([sec("민지", [para("p1", "민지는 저녁마다 짧게 답했어요"), para("p2", "답장은 {{stat:replyMedianMs.민지}} 안에 왔어요")], [], "민지")]),
    );
    expect(r.content?.sections[0].paragraphs).toHaveLength(2);
  });

  // v2.5: 근거 없는 사람 문단(ungrounded)을 지우지 않는다. v2.2~v2.4는 섹션째 또는 이름이 든 문단을 지웠다
  it("근거도 자리표시자도 없는 사람 섹션도 남는다. 원문과 안 맞는 근거는 근거 id만 빠진다", () => {
    const r = run(
      report([
        sec("철수", [para("p1", "질문을 자주 했어요"), para("p2", "저녁에 자주 보였어요")], [], "철수"),
        sec(
          "방",
          [para("p1", "저녁 8시에 대화가 몰려요"), para("p2", "철수가 늘 먼저 물었어요", ["e1"]), para("p3", "주말엔 조용해요")],
          [ev("e1", "m999", "없는 메시지")],
          "group",
        ),
      ]),
    );
    expect(r.content?.sections.map((s) => s.title)).toEqual(["철수", "방"]);
    expect(r.content?.sections[0].paragraphs).toHaveLength(2);
    expect(r.content?.sections[1].paragraphs.map((p) => [p.key, p.text, p.evidence_ids])).toEqual([
      ["p1", "저녁 8시에 대화가 몰려요", []],
      ["p2", "철수가 늘 먼저 물었어요", []],
      ["p3", "주말엔 조용해요", []],
    ]);
    expect(r.dropped).toMatchObject({ paragraphs: 0, evidence: 1 });
    expect(r.status).toBe("done");
  });

  const evidence = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => ev(`${prefix}${i + 1}`, `m${i % 12}`, idx.get(`m${i % 12}`)!.text.split(" ⏎ ")[0]));
  const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

  it("근거는 리포트 전체에서 30개까지, 앞 섹션부터 센다", () => {
    const r = run(
      report([
        sec("앞", [para("p1", "저녁 대화가 이어져요", ids("a", 20))], evidence("a", 20)),
        sec("뒤", [para("p1", "주말 대화가 길어요", ids("b", 20))], evidence("b", 20)),
      ]),
    );
    expect(r.content?.sections[0].evidence).toHaveLength(20);
    expect(r.content?.sections[1].evidence.map((e) => e.id)).toEqual(ids("b", 10));
    expect(r.content?.sections[1].paragraphs[0].evidence_ids).toEqual(ids("b", 10));
    expect(r.dropped.evidence).toBe(10);
  });

  it("몫이 다 떨어져 근거 카드를 못 단 사람 섹션도 원문과 맞은 근거를 단 문단은 남는다(카드만 빠진다)", () => {
    const r = run(
      report([
        sec("앞", [para("p1", "저녁 대화가 이어져요", ids("a", 30))], evidence("a", 30)),
        sec("민지", [para("p1", "민지는 짧게 답했어요", ["b1"]), para("p2", "민지는 저녁마다 보였어요")], evidence("b", 1), "민지"),
        sec("철수", [para("p1", "철수는 질문을 자주 했어요")], [], "철수"),
      ]),
    );
    expect(r.content?.sections.map((s) => [s.title, s.evidence.length, s.paragraphs.length])).toEqual([
      ["앞", 30, 1],
      ["민지", 0, 2],
      ["철수", 0, 1],
    ]);
    expect(r.content?.sections[1].paragraphs.map((p) => p.evidence_ids)).toEqual([[], []]);
  });

  it("마무리 구성 섹션 몫: 앞 섹션이 30개를 다 쓰려 해도 마무리 섹션이 쓰는 근거 2개는 남겨 둔다", () => {
    const r = run(
      report([
        sec("카드", [para("p1", "민지는 저녁마다 짧게 답했어요", ids("a", 30))], evidence("a", 30), "민지", "nag_cards"),
        sec("마지막 한마디", [para("p1", "민지, 철수. 저녁 8시는 이제 둘의 시간이다", ["e1", "e2", "e3"])], evidence("e", 3), "pair", "nag_last"),
      ]),
    );
    expect(r.content?.sections.map((s) => [s.part, s.evidence.length])).toEqual([
      ["nag_cards", 28],
      ["nag_last", 2],
    ]);
    expect(r.content?.sections[1].paragraphs[0].evidence_ids).toEqual(["e1", "e2"]);
    expect(r.content?.sections.flatMap((s) => s.evidence)).toHaveLength(30);
    // 마무리 섹션이 근거를 쓰지 않으면 몫을 떼어 두지 않는다
    const noClosing = run(
      report([
        sec("카드", [para("p1", "민지는 저녁마다 짧게 답했어요", ids("a", 30))], evidence("a", 30), "민지", "nag_cards"),
        sec("마지막 한마디", [para("p1", "저녁 8시는 이제 둘의 시간이다")], [], "pair", "nag_last"),
      ]),
    );
    expect(noClosing.content?.sections.map((s) => s.evidence.length)).toEqual([30, 0]);
    // 다른 말투에서는 그 말투의 마지막 구성(care_letter)이 몫을 받는다
    const warm = run(
      report([
        sec("사람", [para("p1", "민지는 저녁마다 짧게 답했어요", ids("a", 30))], evidence("a", 30), "민지", "care_people"),
        sec("편지", [para("p1", "민지, 철수. 저녁 8시를 잘 지켜 왔어요", ["e1"])], evidence("e", 1), "pair", "care_letter"),
      ]),
      false,
      "warm",
    );
    expect(warm.content?.sections.map((s) => s.evidence.length)).toEqual([29, 1]);
  });

  it("어느 문단도 쓰지 않는 고아 근거는 상한 전에 버린다: 뒤 섹션이 쓰는 근거가 남는다", () => {
    const r = run(
      report([
        sec("앞", [para("p1", "저녁 대화가 이어져요")], evidence("a", 10)),
        sec("뒤", [para("p1", "철수가 먼저 물었어요", ids("b", 8))], evidence("b", 8)),
      ]),
    );
    expect(r.content?.sections[0].evidence).toEqual([]);
    expect(r.content?.sections[1].evidence.map((e) => e.id)).toEqual(ids("b", 8));
    expect(r.content?.sections[1].paragraphs[0].evidence_ids).toEqual(ids("b", 8));
    expect(r.dropped.evidence).toBe(10);
  });

  it("문단이 모두 지워진 섹션은 빠지고 근거 몫을 쓰지 않는다", () => {
    const r = run(
      report([
        sec("지워짐", [para("p1", "대화의 90%")], [ev("e1", "m1", "쉬는 중")]),
        sec("남음", [para("p1", "저녁 대화가 이어져요", ["e1"])], [ev("e1", "m1", "집에서")]),
      ]),
    );
    expect(r.content?.sections.map((s) => s.title)).toEqual(["남음"]);
    expect(r.dropped).toMatchObject({ paragraphs: 1, evidence: 1 });
  });

  it("headline·dek·섹션 제목·reading_notes의 금지 표현은 비운다", () => {
    const r = run(
      report([sec("철수는 게이다", [para("p1", "저녁 대화가 이어져요")])], {
        headline: "민지가 동성애자인 것 같은 방",
        dek: "여자라서 그렇다",
        reading_notes: [
          { range: "10-01", note: "한 대 때려 줘야 한다" },
          { range: "10-02", note: "저녁 대화" },
        ],
      }),
    );
    expect(r.content?.headline).toBe("");
    expect(r.content?.dek).toBe("");
    expect(r.content?.sections[0].title).toBe("");
    expect(r.content?.reading_notes).toEqual([{ range: "10-02", note: "저녁 대화" }]);
    expect(r.status).toBe("done");
  });

  it("모델 글의 개인정보(전화·링크·계좌·이메일)를 다시 검사한다: 문단은 지우고 headline·dek·제목·메모는 비운다 (PRD 5장 6)", () => {
    const r = run(
      report(
        [
          sec("010-1234-5678로 연락", [
            para("p1", "저녁 대화가 이어져요"),
            para("p2", "번호는 010-9999-8888이에요"),
            para("p3", "minji@example.com으로 보냈어요"),
          ]),
        ],
        {
          headline: "010-1234-5678의 비밀",
          dek: "https://example.com/x 에서 시작",
          reading_notes: [
            { range: "10-01", note: "instagram.com/minji 링크" },
            { range: "10-02", note: "저녁 대화" },
          ],
        },
      ),
    );
    expect(r.content?.headline).toBe("");
    expect(r.content?.dek).toBe("");
    expect(r.content?.sections[0].title).toBe("");
    expect(r.content?.sections[0].paragraphs.map((p) => p.key)).toEqual(["p1"]);
    expect(r.content?.reading_notes).toEqual([{ range: "10-02", note: "저녁 대화" }]);
    expect(r.dropped.paragraphs).toBe(2);
  });

  // 표시 이름이 링크 끝과 같은 영어 낱말(Me·Com …)이어도 풀리는 자리표시자는 개인정보 검사에서 뺀다 (N1)
  it("풀리는 {{stat:…}} 자리표시자 속 표시 이름(Me·Com)은 링크로 보지 않는다. 자리표시자 밖의 개인정보는 그대로 지운다", () => {
    const f = fixture("Com", "Me");
    const r = validateReport(
      report(
        [
          sec("{{stat:byPerson.Me}}개의 메시지", [
            para("p1", "메시지 {{stat:byPerson.Me}}개"),
            para("p2", "10월엔 {{stat:monthly.2026-10.count.Me}}개, 상대는 {{stat:byPerson.Com}}개"),
            para("p3", "{{stat:byPerson.Me}}개, 번호는 010-9999-8888이에요"),
            para("p4", "{{stat:byPerson.Com}}개, minji.github.io 블로그"),
          ]),
        ],
        { headline: "{{stat:share.Me}}만큼 먼저", dek: "{{stat:byPerson.Com}}개의 답장" },
      ),
      f.idx,
      f.stats,
      { truncated: false, tone: "fact", members: f.members },
    );
    expect(r.content?.sections[0].paragraphs.map((p) => p.key)).toEqual(["p1", "p2"]);
    expect(r.content?.sections[0].title).toBe("{{stat:byPerson.Me}}개의 메시지");
    expect(r.content?.headline).toBe("{{stat:share.Me}}만큼 먼저");
    expect(r.content?.dek).toBe("{{stat:byPerson.Com}}개의 답장");
  });

  it("풀리지 않는 자리표시자 속 개인정보는 숨지 않는다: 제목·headline을 비운다", () => {
    const r = run(
      report([sec("{{stat:010-1234-5678}} 연락", [para("p1", "저녁 대화가 이어져요")])], {
        headline: "{{minji@example.com}}",
      }),
    );
    expect(r.content?.sections[0].title).toBe("");
    expect(r.content?.headline).toBe("");
  });

  it("가린 표시([가림:…])가 든 인용·문단은 개인정보로 보지 않는다", () => {
    const r = run(report([sec("가린 것", [para("p1", "[가림:전화]를 주고받았어요")])]));
    expect(r.content?.sections[0].paragraphs).toHaveLength(1);
  });

  it("글자 수를 맞춘다: 너무 긴 headline·dek·제목은 비우고, 너무 긴 문단은 지운다 (PRD 5장 1)", () => {
    const r = run(
      report([sec("가".repeat(61), [para("p1", "저녁 대화가 이어져요"), para("p2", "나".repeat(1201)), para("p3", "다".repeat(1200))])], {
        headline: "다".repeat(81),
        dek: "라".repeat(201),
      }),
    );
    expect(r.content?.headline).toBe("");
    expect(r.content?.dek).toBe("");
    expect(r.content?.sections[0].title).toBe("");
    // v2.3: 문단 상한 1200자(지시 250~400자의 세 배 여유)
    expect(r.content?.sections[0].paragraphs.map((p) => p.text.length)).toEqual([11, 1200]);
  });

  it("icon은 이모지 몇 글자만(글자·숫자가 들면 비운다), about은 pair·group·참여자 이름만(me·모르는 값은 group)", () => {
    const r = run(
      report([
        { ...sec("하나", [para("p1", "저녁 대화가 이어져요")]), icon: "철수는 분명 좋아해요", about: "아무 말" },
        { ...sec("둘", [para("p1", "메시지 {{stat:byPerson.민지}}개")]), icon: "👨‍👩‍👧", about: "민지" },
        { ...sec("셋", [para("p1", "메시지 {{stat:byPerson.민지}}개")]), icon: "🌙", about: "me" },
      ]),
    );
    expect(r.content?.sections.map((x) => [x.icon, x.about])).toEqual([
      ["", "group"],
      ["👨‍👩‍👧", "민지"],
      ["🌙", "group"],
    ]);
  });

  it("about에 범례 기호(A·B)를 쓰면 그 표시 이름으로 바꿔 사람 섹션으로 둔다(리뷰 minor 6)", () => {
    // fixture의 범례: A=철수, B=민지
    const r = run(report([sec("민지", [para("p1", "민지는 저녁마다 짧게 답했어요", ["e1"])], [ev("e1", "m1", "쉬는 중")], "B", "nag_cards")]));
    expect(r.content?.sections[0].about).toBe("민지");
    expect(run(report([sec("방", [para("p1", "저녁 대화가 이어져요")], [], "Z")])).content?.sections[0].about).toBe("group");
  });

  it("part: 그 말투의 구성 키만 남기고 나머지(다른 말투의 키, 예전 컨셉 키)는 빈 글. 섹션 순서는 그대로", () => {
    const body = [para("p1", "저녁 대화가 이어져요")];
    const raw = report(
      ["nag_open", "care_letter", "chronicle", "x"].map((part, i) => sec(`섹션${i}`, body, [], "pair", part)),
    );
    expect(run(raw).content?.sections.map((x) => [x.title, x.part])).toEqual([
      ["섹션0", "nag_open"],
      ["섹션1", ""],
      ["섹션2", ""],
      ["섹션3", ""],
    ]);
    expect(run(raw, false, "warm").content?.sections.map((x) => x.part)).toEqual(["", "care_letter", "", ""]);
  });

  it("같은 섹션의 겹친 문단 키는 p1, p2…로 다시 매기고 evidence_ids는 그대로", () => {
    const r = run(
      report([
        sec(
          "겹침",
          [para("p1", "저녁 대화가 이어져요", ["e1"]), para("p1", "주말 대화가 길어요", ["e2"])],
          [ev("e1", "m1", "쉬는 중"), ev("e2", "m3", "좋아!")],
        ),
      ]),
    );
    expect(r.content?.sections[0].paragraphs).toEqual([
      { key: "p1", text: "저녁 대화가 이어져요", evidence_ids: ["e1"] },
      { key: "p2", text: "주말 대화가 길어요", evidence_ids: ["e2"] },
    ]);
  });

  it("자리표시자 경로 속 범례 기호는 표시 이름으로 바꿔 저장한다", () => {
    const f = fixture("민지", "철수");
    expect(f.members[0]).toBe("민지");
    const [a, b] = memberCodes(f.members);
    const r = validateReport(
      report([sec(`{{stat:byPerson.${b}}}개`, [para("p1", `민지의 지분은 {{stat:share.${a}}}예요`), para("p2", "기호 없는 문단")])], {
        headline: `{{stat:initiations.${a}}}번의 선톡`,
      }),
      f.idx,
      f.stats,
      { truncated: false, tone: "fact", members: f.members },
    );
    expect(r.status).toBe("done");
    expect(r.content?.sections[0].paragraphs[0].text).toBe("민지의 지분은 {{stat:share.민지}}예요");
    expect(r.content?.sections[0].title).toBe("{{stat:byPerson.철수}}개");
    expect(r.content?.headline).toBe("{{stat:initiations.민지}}번의 선톡");
  });

  it("v1 모양 출력(episode·next_teaser, part 없음)도 done이고 저장 내용에 그 키가 없다", () => {
    const { part: _part, ...v1Section } = sec("저녁", [para("p1", "저녁 대화가 이어져요")]);
    const r = run({ episode: 1, ...report([v1Section as Section]), next_teaser: "다음 편: 누가 먼저" });
    expect(r.status).toBe("done");
    expect(r.content).not.toHaveProperty("episode");
    expect(r.content).not.toHaveProperty("next_teaser");
    expect(r.content?.sections[0].part).toBe("");
  });

  it("4구성 중 3구성까지 완결된 truncated는 partial이고 part가 셋", () => {
    const body = [para("p1", "저녁 대화가 이어져요")];
    const r = run(report(["nag_open", "nag_cards", "nag_room"].map((part) => sec(part, body, [], "pair", part))), true);
    expect(r.status).toBe("partial");
    expect(r.content?.sections.map((x) => x.part)).toEqual(["nag_open", "nag_cards", "nag_room"]);
  });

  it("v2.2 분량의 긴 리포트(섹션 10개 × 문단 5개, 인용 30개, 문단마다 근거를 달지 않음)도 지우는 것 없이 done", () => {
    const quotes = ["오늘 뭐해?", "쉬는 중", "영화 볼래?", "좋아!"];
    const long = "저녁이 되면 이 방은 다시 살아난다. 한 사람이 운을 떼면 다른 사람이 곧 받아 이어 간다. 대화는 짧은 말로 시작해 영화 이야기로 번진다. 그리고 늘 같은 말로 끝난다.";
    const sections = Array.from({ length: 10 }, (_, si) =>
      sec(
        si % 2 === 0 ? `민지 편 ${si}` : `철수 편 ${si}`,
        Array.from({ length: 5 }, (_, pi) => para(`p${pi + 1}`, `${si % 2 === 0 ? "민지" : "철수"}의 장면 ${pi}. ${long}`, pi < 3 ? [`e${pi + 1}`] : [])),
        Array.from({ length: 3 }, (_, ei) => ev(`e${ei + 1}`, `m${(si + ei) % 4}`, quotes[(si + ei) % 4])),
        si % 2 === 0 ? "민지" : "철수",
        "nag_cards",
      ),
    );
    const r = run(report(sections));
    expect(r.status).toBe("done");
    expect(r.dropped).toMatchObject({ paragraphs: 0, evidence: 0 });
    expect(r.content?.sections).toHaveLength(10);
    expect(r.content?.sections.flatMap((s) => s.evidence)).toHaveLength(30);
    expect(r.content?.sections.flatMap((s) => s.paragraphs)).toHaveLength(50);
  });

  it("모르는 declined_topics 값은 버리고 편은 살린다(SDK 스키마 변환이 enum을 강제하지 않는다)", () => {
    const raw = { ...report([sec("s", [para("p1", "저녁 대화가 이어져요")])]), declined_topics: ["hate", "health", 3] };
    const r = run(raw);
    expect(r.status).toBe("done");
    expect(r.content?.declined_topics).toEqual(["hate"]);
  });

  it("safety.flag가 none이 아니면 safety", () => {
    const r = run(report([sec("s", [para("p1", "저녁 대화")])], { safety: { flag: "self_harm" } }));
    expect(r).toEqual({ status: "safety", content: null, dropped: { paragraphs: 0, evidence: 0, checks: { relinked: 0, requoted: 0, unquoted: 0, dropped_by: {} } } });
  });

  it("표에 없는 none 아닌 flag도 safety (SDK 스키마 변환이 enum을 강제하지 않는다)", () => {
    for (const flag of ["unknown", "self-harm", "자해", ""]) {
      const r = run(report([sec("s", [para("p1", "저녁 대화")])], { safety: { flag: flag as "none" } }));
      expect(r, flag).toEqual({ status: "safety", content: null, dropped: { paragraphs: 0, evidence: 0, checks: { relinked: 0, requoted: 0, unquoted: 0, dropped_by: {} } } });
    }
  });

  it("safety가 걸린 응답은 다른 필드가 구조 검사에 맞지 않아도 safety", () => {
    const flagged = { safety: { flag: "violence" } };
    // 섹션 모양이 틀렸다
    expect(run({ ...report([sec("s", [para("p1", "저녁 대화")])]), ...flagged, sections: [{ part: 3 }] }).status).toBe("safety");
    // 뒤쪽 필드가 없다(truncated 아님)
    expect(run({ ...flagged }).status).toBe("safety");
    expect(run({ ...flagged, sections: "x" }, true).status).toBe("safety");
  });

  it("flag의 대소문자·앞뒤 공백은 무시한다: ' None '은 none", () => {
    const r = run(report([sec("s", [para("p1", "저녁 대화가 이어져요")])], { safety: { flag: " None " as "none" } }));
    expect(r.status).toBe("done");
    expect(r.content?.safety).toEqual({ flag: "none" });
  });

  it("구조가 틀리면 failed, 완결 섹션이 0개여도 failed", () => {
    expect(run({ headline: "h" }).status).toBe("failed");
    expect(run("not json").status).toBe("failed");
    // flag가 문자열이 아니면 safety 판정을 할 수 없다
    expect(run(report([sec("s", [para("p1", "저녁 대화")])], { safety: { flag: 3 as unknown as "none" } })).status).toBe("failed");
    expect(run({ ...report([sec("s", [para("p1", "저녁 대화")])]), safety: null }).status).toBe("failed");
    expect(run(report([])).status).toBe("failed");
    expect(run(report([sec("s", [para("p1", "확률 99%")])])).content).toBeNull();
  });

  // v2.4: 긴 입력에서 m번호를 잘못 옮겨도 quote가 글자 그대로 든 메시지가 있으면 가장 가까운 번호로 다시 잇는다
  it("relink: msg_id가 틀린 근거는 quote가 든 가장 가까운 메시지로 다시 잇고, 보낸 사람·시각은 그 메시지의 것이다", () => {
    const r = run(
      report([
        sec(
          "민지",
          [para("p1", "민지는 저녁마다 집에서 쉬었다", ["e1"]), para("p2", "약속에는 늘 좋다고 답했다", ["e2"])],
          // e1: 없는 번호, 긴 quote → 전체에서 가장 가까운 m9. e2: m4에는 없지만 가까운 m3(민지)에 있다
          [ev("e1", "m999", "집에서 쉬는 중"), ev("e2", "m4", "좋아!")],
          "민지",
        ),
      ]),
    );
    expect(r.status).toBe("done");
    expect(r.content?.sections[0].evidence).toEqual([
      { id: "e1", msg_id: "m9", quote: "집에서 쉬는 중", sender: "민지", at: "2026-10-03T20:05:00+09:00" },
      { id: "e2", msg_id: "m3", quote: "좋아!", sender: "민지", at: "2026-10-01T20:10:00+09:00" },
    ]);
    expect(r.dropped).toMatchObject({ paragraphs: 0, evidence: 0, checks: { relinked: 2, requoted: 0, dropped_by: {} } });
    expect(r.content?.checks).toEqual({ relinked: 2, requoted: 0, unquoted: 0, dropped_by: {} });
  });

  it(`relink: 짧은 quote는 ${RELINK_NEAR}번 안에서만 찾고, 없으면 근거만 뺀다(v2.5부터 문단은 남는다)`, () => {
    const r = run(
      report([
        sec(
          "근거",
          [para("p1", "저녁 대화가 이어졌다", ["e1"]), para("p2", "주말엔 조용했다")],
          [ev("e1", `m${11 + RELINK_NEAR + 1}`, "좋아!")],
        ),
      ]),
    );
    expect(r.content?.sections[0].paragraphs.map((p) => [p.text, p.evidence_ids])).toEqual([
      ["저녁 대화가 이어졌다", []],
      ["주말엔 조용했다", []],
    ]);
    expect(r.dropped.checks).toEqual({ relinked: 0, requoted: 0, unquoted: 0, dropped_by: { evidence_unmatched: 1 } });
  });

  it("relink: 사람 섹션이면 그 사람이 보낸 메시지를 먼저 고른다(더 가까운 다른 사람 메시지보다)", () => {
    const at = "2026-10-01T20:00:00+09:00";
    const own = new Map([
      ["m10", { sender: "민지", at, text: "오늘 저녁 맛있었다" }],
      ["m20", { sender: "철수", at, text: "오늘 저녁 맛있었다" }],
    ]);
    const r = validateReport(
      report([sec("민지", [para("p1", "민지는 저녁 이야기를 했다", ["e1"])], [ev("e1", "m21", "오늘 저녁 맛있었다")], "민지")]),
      own,
      stats,
      { truncated: false, tone: "fact", members },
    );
    expect(r.content?.sections[0].evidence.map((e) => [e.msg_id, e.sender])).toEqual([["m10", "민지"]]);
  });

  it("checks: 지운 까닭을 센다(숫자만 저장한다)", () => {
    const r = run(
      report([
        sec(
          "까닭",
          [
            para("p1", "저녁 대화가 이어졌다", ["e1"]),
            para("p2", "철수는 게이가 분명해요"),
            para("p3", "민지는 \"나는 철수가 제일 좋아\"라고 했다"),
            para("p4", "대화는 {{stat:nope}}개"),
            para("p5", "이 문단은 근거가 틀렸다", ["e2"]),
            para("p6", ""),
          ],
          [ev("e1", "m1", "쉬는 중"), ev("e2", "m1", "없는 말"), ev("e3", "m3", "좋아!")],
        ),
      ]),
    );
    expect(r.content?.checks).toEqual({
      relinked: 0,
      requoted: 0,
      unquoted: 1,
      dropped_by: { banned: 1, placeholder: 1, empty: 1, evidence_unmatched: 1, evidence_orphan: 1 },
    });
  });

  // v2.5: 판정(실세·범인)도 속마음·호감 단정도 진단명도 남고, 속성 비하·성적 지향 단정·폭력 부추김만 지운다(표 테스트는 policy.test)
  it("판정 문장·호감 단정·진단명 붙이기는 남고, 속성 비하·성적 지향 단정·폭력 부추김은 지운다", () => {
    const keep = [
      "이 방의 실세는 철수다.",
      "약속 증발 사건의 범인은 민지다.",
      "새벽 수다의 주범이 철수임이 틀림없다.",
      "민지가 이 방의 연결 반장인 것 같다.",
      "철수가 범인일 확률이 매우 높다.",
      "철수는 민지를 놀리는 걸 좋아한다.",
      "민지는 사실 철수를 좋아한다.",
      "철수는 민지한테 반했다.",
      "철수는 민지에게 은근히 관심이 있다.",
      "철수는 ADHD다.",
    ];
    const drop = ["민지는 여자라서 약속을 못 지킨다.", "철수는 게이다.", "철수를 한 대 때려 줘야 한다."];
    const grounded = para("p0", "저녁마다 쉬는 이야기가 나왔다", ["e1"]);
    const r = run(report([sec("판정", [grounded, ...[...keep, ...drop].map((t, i) => para(`p${i + 1}`, t))], [ev("e1", "m1", "쉬는 중")])]));
    expect(r.content?.sections[0].paragraphs.map((p) => p.text).slice(1)).toEqual(keep);
    expect(r.dropped.checks.dropped_by).toEqual({ banned: drop.length });
    // 제목·헤드라인도 같은 검사
    const head = run(report([sec("민지는 철수를 좋아한다", [para("p1", "저녁 대화가 이어졌다")])], { headline: "이 방의 실세는 철수다", dek: "철수는 레즈비언이다" }));
    expect(head.content?.sections[0].title).toBe("민지는 철수를 좋아한다");
    expect(head.content?.dek).toBe("");
    expect(head.content?.headline).toBe("이 방의 실세는 철수다");
  });

  // v2.5(실측 3: inline_quote 7개로 문단이 지워졌다): 띄어쓰기·문장부호·ㅋ 개수·두 메시지 합침·글자 겹침 80%는 같은 말로 본다
  it("v2.5: 원문과 조금 다른 따옴표 대사는 정규화해서 맞으면 그대로 남는다", () => {
    const texts = [
      // 띄어쓰기·문장부호·ㅋ 개수
      "민지는 \"집에서 쉬는중 ㅋㅋㅋㅋ\"이라고 답했다.",
      "민지는 \"집에서 쉬는 중...!\"이라고 답했다.",
      // 연속한 두 메시지를 합쳤다(철수 m2 "영화 볼래?\n내일 저녁"은 한 메시지, m0 "오늘 뭐해?"와 m2를 합침)
      "철수는 \"오늘 뭐해? 영화 볼래?\"라고 물었다.",
      // 글자 겹침 80% 이상(ㅋ과 ㅎ 한 글자 다름)
      "민지는 \"집에서 쉬는 중 ㅎㅎ\"이라고 했다.",
    ];
    const r = run(report([sec("민지", texts.map((t, i) => para(`p${i + 1}`, t, ["e1"])), [ev("e1", "m1", "쉬는 중")], "민지")]));
    expect(r.content?.sections[0].paragraphs.map((p) => p.text)).toEqual(texts);
    expect(r.content?.checks).toMatchObject({ unquoted: 0, dropped_by: {} });
    expect(r.status).toBe("done");
  });

  it("리뷰 I1: 뜻을 뒤집은 따옴표 대사(부정어를 더함·글자 순서를 바꿈)는 비슷해도 따옴표를 뗀다", () => {
    const texts = [
      "민지는 \"집에서 안 쉬는 중 ㅋㅋ\"이라고 답했다.",
      "철수는 \"내일 저녁 영화 볼래?\"라고 물었다.",
      "철수는 \"영화 안 볼래? 내일 저녁\"이라고 물었다.",
    ];
    const r = run(report([sec("민지", texts.map((t, i) => para(`p${i + 1}`, t, ["e1"])), [ev("e1", "m1", "쉬는 중")], "민지")]));
    expect(r.content?.sections[0].paragraphs.map((p) => p.text)).toEqual([
      "민지는 집에서 안 쉬는 중 ㅋㅋ이라고 답했다.",
      "철수는 내일 저녁 영화 볼래?라고 물었다.",
      "철수는 영화 안 볼래? 내일 저녁이라고 물었다.",
    ]);
    expect(r.content?.checks).toMatchObject({ unquoted: 3, dropped_by: {} });
  });

  it("v2.5: 따옴표 대사가 많이 틀려도 문단이 지워지지 않아 partial이 되지 않는다", () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => para(`p${i + 1}`, `민지는 \"지어낸 말 ${i}번\"이라고 했다.`));
    const r = run(report([sec("민지", paragraphs, [], "민지")]));
    expect(r.status).toBe("done");
    expect(r.content?.sections[0].paragraphs.map((p) => p.text)).toEqual(Array.from({ length: 10 }, (_, i) => `민지는 지어낸 말 ${i}번이라고 했다.`));
    expect(r.content?.checks).toMatchObject({ unquoted: 10, dropped_by: {} });
  });

  it("v2.5 근거: m번호 메시지와 정규화로 맞으면 그 메시지의 원문 글자로 바꿔 넣는다(requoted)", () => {
    const r = run(
      report([
        sec(
          "근거",
          [para("p1", "저녁마다 쉬었다", ["e1", "e2", "e3"])],
          // e1: 띄어쓰기만 다름 → 원문 "쉬는 중". e2: ㅋ 개수 → 원문의 ㅋ 반복까지. e3: 줄바꿈·문장부호 없이
          [ev("e1", "m1", "쉬는중"), ev("e2", "m1", "쉬는 중ㅋㅋㅋㅋ"), ev("e3", "m2", "볼래 내일 저녁")],
        ),
      ]),
    );
    expect(r.content?.sections[0].evidence.map((e) => [e.msg_id, e.quote, e.sender])).toEqual([
      ["m1", "쉬는 중", "민지"],
      ["m1", "쉬는 중 ㅋㅋ", "민지"],
      ["m2", "볼래?\n내일 저녁", "철수"],
    ]);
    expect(r.content?.checks).toMatchObject({ requoted: 3, relinked: 0, dropped_by: {} });
  });

  it("v2.5 근거: 정규화로 relink하고, 그래도 없으면 m번호 메시지와 글자 겹침 80% 이상일 때 그 메시지 전체를 넣는다", () => {
    const r = run(
      report([
        sec(
          "민지",
          [para("p1", "민지는 저녁마다 쉬었다", ["e1", "e2", "e3"])],
          [
            // e1: m0(철수 "오늘 뭐해?")에는 없고 가까운 m1(민지)에 정규화로 있다
            ev("e1", "m0", "집에서쉬는중"),
            // e2: m3 "좋아!"와 한 글자 다름(겹침 2/2가 아니다) → 못 찾는다
            ev("e2", "m3", "싫어!"),
            // e3: m5(민지 "집에서 쉬는 중 ㅋㅋ")와 글자 겹침 80% 이상 → 메시지 전체
            ev("e3", "m5", "집에서 쉬는 중 ㅎㅎ"),
          ],
          "민지",
        ),
      ]),
    );
    expect(r.content?.sections[0].evidence.map((e) => [e.id, e.msg_id, e.quote, e.sender])).toEqual([
      ["e1", "m1", "집에서 쉬는 중", "민지"],
      ["e3", "m5", "집에서 쉬는 중 ㅋㅋ", "민지"],
    ]);
    expect(r.content?.checks).toMatchObject({ relinked: 1, requoted: 2, dropped_by: { evidence_unmatched: 1 } });
    // 문단은 남고 못 찾은 근거 id만 빠진다
    expect(r.content?.sections[0].paragraphs[0].evidence_ids).toEqual(["e1", "e3"]);
  });

  // 리뷰 minor 3: 검증은 270초 마감 뒤에 돌고 maxDuration까지 30초뿐이다. 이름 없는 따옴표는 모든 메시지와 대 보므로 큰 대화에서도 빨라야 한다
  it("큰 가짜 대화(메시지 약 5만 개·60만 자)에서 지어낸 따옴표 320개가 든 리포트도 1초 안에 검증한다", () => {
    const names = ["민지", "철수", "영희", "지훈", "수아"];
    const syll = "가나다라마바사아자차카타파하오늘내일영화보러갈래진짜너무좋아싫어회사집밥먹자언제어디왜ㅋㅋㅎㅎ";
    let seed = 7;
    const rnd = (k: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % k;
    };
    const word = () => Array.from({ length: 1 + rnd(4) }, () => syll[rnd(syll.length)]).join("");
    const messages: ChatMessage[] = [];
    for (let chars = 0, id = 0; chars < 600_000; id++) {
      const text = Array.from({ length: 2 + rnd(10) }, word).join(" ");
      chars += text.length;
      messages.push({ id, ts: Date.UTC(2026, 0, 1) + id * 60_000, sender: names[rnd(names.length)], kind: "text", text, line: id + 1 });
    }
    const p = buildPayload({ messages, tone: "fact", concept: "group", kind: "group", tokenBudget: 2_000_000, tokensPerChar: 1 });
    const big = payloadIndex(p);
    expect(big.size).toBeGreaterThan(50_000);
    const fake = () => `"${word()}${word()} ${word()} ${word()}"`;
    const sections = Array.from({ length: 16 }, (_, s) =>
      sec(
        `섹션 ${s}`,
        Array.from({ length: 5 }, (_, k) => para(`p${k + 1}`, `누군가 ${fake()} 하고 말했다. 그리고 또 ${fake()} 하고 이어졌다. `.repeat(2))),
        [],
        "group",
      ),
    );
    const t0 = performance.now();
    const r = validateReport(report(sections), big, p.stats, { truncated: false, tone: "fact", members: p.members });
    const ms = performance.now() - t0;
    expect(r.status).toBe("done");
    expect(r.content?.checks?.unquoted).toBeGreaterThan(100);
    expect(ms, `검증 ${Math.round(ms)}ms`).toBeLessThan(1_000);
  });

  // v2.7: 같은 분에 연달아 보낸 메시지는 한 줄(m<첫 id>+<k>)로 묶여 간다. 모델이 줄 머리 번호를 들어도 말풍선은 실제 메시지 하나다
  describe("v2.7 묶음 줄", () => {
    const bundled = () => {
      const rows: [string, number, string][] = [
        ["철수", kst(1, 20, 0), "오늘 영화 볼래?"],
        ["민지", kst(1, 20, 5), "집에서 쉬는 중"],
        ["민지", kst(1, 20, 5), "넷플릭스 보는 중이야"],
        ["민지", kst(1, 20, 5), "같이 볼래?"],
        ["철수", kst(1, 20, 6), "영화 볼래?\n내일 저녁"],
        ["철수", kst(1, 20, 6), "ㅋㅋ"],
        ["민지", kst(1, 20, 10), "좋아!"],
      ];
      const messages: ChatMessage[] = rows.map(([sender, ts, text], id) => ({ id, ts, sender, kind: "text", text, line: id + 1 }));
      const build = (tokenBudget: number) => buildPayload({ messages, tone: "fact", concept: "couple", kind: "pair", tokenBudget, tokensPerChar: 1 });
      const p = build(build(1_000_000).transcript.length);
      return { p, idx: payloadIndex(p) };
    };
    const { p, idx: bIdx } = bundled();
    const runB = (raw: unknown) => validateReport(raw, bIdx, p.stats, { truncated: false, tone: "fact", members: p.members });
    const one = (msg_id: string, quote: string, about = "group") =>
      runB(report([sec("근거", [para("p1", "저녁 대화가 이어졌다", ["e1"])], [ev("e1", msg_id, quote)], about)]));

    it("전제: 민지의 세 메시지가 m1+2 한 줄, 철수의 글·반응이 m4+1 한 줄로 갔다", () => {
      expect(p.transcript.split("\n").map((l) => l.split("|")[0])).toEqual(["# 2026-10-01", "m0", "m1+2", "m4+1", "m6"]);
    });

    it("줄 머리 번호(m1)를 들어도 quote가 든 같은 줄의 메시지(m3)로 잇고, 보낸 사람·시각은 그 메시지의 것이다(relink로 세지 않는다)", () => {
      const r = one("m1", "같이 볼래?");
      expect(r.content?.sections[0].evidence).toEqual([{ id: "e1", msg_id: "m3", quote: "같이 볼래?", sender: "민지", at: "2026-10-01T20:05:00+09:00" }]);
      expect(r.content?.checks).toMatchObject({ relinked: 0, requoted: 0, dropped_by: {} });
    });

    it("머리를 그대로 옮긴 m1+2도 m1로 읽는다", () => {
      expect(one("m1+2", "넷플릭스 보는 중").content?.sections[0].evidence.map((e) => [e.msg_id, e.quote])).toEqual([["m2", "넷플릭스 보는 중"]]);
    });

    it("같은 줄 메시지를 먼저 본다: 짧은 quote가 번호가 더 가까운 다른 사람 메시지(m0)에도 있어도 같은 줄의 m3", () => {
      expect(one("m1", "볼래?").content?.sections[0].evidence.map((e) => [e.msg_id, e.sender])).toEqual([["m3", "민지"]]);
    });

    it("같은 줄 메시지와 정규화로 맞으면 그 메시지의 원문 글자로 바꿔 넣는다(requoted)", () => {
      const r = one("m1", "넷플릭스보는중이야");
      expect(r.content?.sections[0].evidence.map((e) => [e.msg_id, e.quote])).toEqual([["m2", "넷플릭스 보는 중이야"]]);
      expect(r.content?.checks).toMatchObject({ relinked: 0, requoted: 1 });
    });

    it("두 메시지에 걸친 근거는 이어 붙인 글로 보이지 않는다: 같은 줄 메시지 하나와 80% 넘게 겹치면 그 메시지 전체, 아니면 뺀다(문단은 남는다)", () => {
      const close = one("m1", "쉬는 중 넷플릭스");
      expect(close.content?.sections[0].evidence.map((e) => [e.msg_id, e.quote])).toEqual([["m2", "넷플릭스 보는 중이야"]]);
      const r = one("m1", "중 같이");
      expect(r.content?.sections[0].evidence).toEqual([]);
      expect(r.content?.sections[0].paragraphs[0].evidence_ids).toEqual([]);
      expect(r.content?.checks).toMatchObject({ dropped_by: { evidence_unmatched: 1 } });
    });

    it("문단 안 따옴표 대사는 묶음의 메시지들(연속 두세 개 이어 붙인 것 포함)과 대 본다", () => {
      const r = runB(
        report([
          sec("민지", [para("p1", '민지는 "집에서 쉬는 중 넷플릭스 보는 중이야"라고 했다. 그리고 "같이 볼래?" 하고 물었다. 철수는 "영화 볼래"라고 했다')], [], "민지"),
        ]),
      );
      expect(r.content?.sections[0].paragraphs[0].text).toContain('"집에서 쉬는 중 넷플릭스 보는 중이야"');
      expect(r.content?.checks).toMatchObject({ unquoted: 0 });
    });
  });

  // v2.8: 인트로 호출이 매기는 케미 온도(chemistry)와 개인별 호출이 쓰는 사람 섹션의 MBTI 추측. 범위·형식만 보고, 틀린 항목만 버린다
  describe("v2.8 케미 온도·MBTI", () => {
    const person = (name: string, mbti: string, mbti_reason = "") => ({
      ...sec(`${name} 카드`, [para("p1", `${name}는 저녁마다 짧게 답했다`)], [], name, "nag_cards"),
      mbti,
      mbti_reason,
    });
    const base = (over: Record<string, unknown> = {}, sections: Section[] = [sec("저녁", [para("p1", "저녁마다 이야기가 이어졌다")])]) =>
      run(report(sections, over as Partial<Report>));

    it("0~100 정수 점수와 한 줄은 그대로 저장한다(한 줄의 {{stat:…}}·판정·점수 말도 된다)", () => {
      const r = base({ chemistry: { score: 78, line: "케미 온도 78도, 탐정의 감으로는 이미 한 팀이다" } });
      expect(r.status).toBe("done");
      expect(r.content?.chemistry).toEqual({ score: 78, line: "케미 온도 78도, 탐정의 감으로는 이미 한 팀이다" });
      expect(base({ chemistry: { score: 0, line: "" } }).content?.chemistry).toEqual({ score: 0, line: "" });
      expect(base({ chemistry: { score: 100, line: "{{stat:total}}개 내내 붙어 다녔다" } }).content?.chemistry?.line).toBe("{{stat:total}}개 내내 붙어 다녔다");
    });

    it("점수가 범위 밖·소수·숫자가 아니거나 모양이 틀리면 케미 온도만 버리고(chemistry_invalid) 리포트는 그대로다", () => {
      for (const chemistry of [{ score: 101, line: "x" }, { score: -1, line: "x" }, { score: 78.5, line: "x" }, { score: "78", line: "x" }, { line: "x" }, "78", 78]) {
        const r = base({ chemistry });
        expect(r.status, JSON.stringify(chemistry)).toBe("done");
        expect(r.content).not.toHaveProperty("chemistry");
        expect(r.content?.checks?.dropped_by).toEqual({ chemistry_invalid: 1 });
      }
    });

    it("null이거나 없으면(맡지 않은 응답·예전 출력) 케미 온도 없이 저장하고 세지 않는다", () => {
      for (const over of [{ chemistry: null }, { chemistry: undefined }]) {
        const r = base(over);
        expect(r.status).toBe("done");
        expect(r.content).not.toHaveProperty("chemistry");
        expect(r.content?.checks?.dropped_by).toEqual({});
      }
    });

    it("한 줄이 80자를 넘거나 금지 표현·개인정보·풀리지 않는 자리표시자가 들면 한 줄만 비운다. 원문에 없는 따옴표는 뗀다", () => {
      const line = (text: string) => base({ chemistry: { score: 64, line: text } }).content?.chemistry;
      expect(line("가".repeat(81))).toEqual({ score: 64, line: "" });
      expect(line("가".repeat(80))).toEqual({ score: 64, line: "가".repeat(80) });
      expect(line("철수는 게이다")).toEqual({ score: 64, line: "" });
      expect(line("케미 64%")).toEqual({ score: 64, line: "" });
      expect(line("연락은 010-1234-5678로")).toEqual({ score: 64, line: "" });
      expect(line("{{stat:nope}} 만큼 붙어 있다")).toEqual({ score: 64, line: "" });
      expect(line('민지는 "사랑해"라고 했다')).toEqual({ score: 64, line: "민지는 사랑해라고 했다" });
    });

    it("사람 섹션의 MBTI: 네 글자 E/I·N/S·T/F·J/P만 남긴다. 앞뒤 공백·소문자는 고쳐 읽는다", () => {
      const r = run(report([person("철수", "ENFP", "영화 제안부터 하는 걸 보니 즉흥형이다"), person("민지", " istj ")]));
      expect(r.status).toBe("done");
      const [a, b] = r.content!.sections;
      expect([a.mbti, a.mbti_reason]).toEqual(["ENFP", "영화 제안부터 하는 걸 보니 즉흥형이다"]);
      expect(b.mbti).toBe("ISTJ");
      expect(b).not.toHaveProperty("mbti_reason");
      expect(r.content?.checks?.dropped_by).toEqual({});
    });

    it("모양이 틀린 MBTI는 그 사람의 MBTI·이유만 버리고(mbti_invalid) 섹션은 남긴다", () => {
      for (const mbti of ["ENFX", "ENFPT", "엔프피", "E N F P", "INFJ-A"]) {
        const r = run(report([person("철수", mbti, "이유 한 줄")]));
        expect(r.status, mbti).toBe("done");
        const s = r.content!.sections[0];
        expect(s.paragraphs).toHaveLength(1);
        expect(s, mbti).not.toHaveProperty("mbti");
        expect(s).not.toHaveProperty("mbti_reason");
        expect(r.content?.checks?.dropped_by).toEqual({ mbti_invalid: 1 });
      }
    });

    it("이유가 80자를 넘거나 금지 표현이 들면 이유만 비운다(MBTI는 남는다). 성격 유형·진단명 꼬리표는 남는다", () => {
      const reason = (text: string) => run(report([person("철수", "INTP", text)])).content!.sections[0];
      expect(reason("가".repeat(81))).not.toHaveProperty("mbti_reason");
      expect(reason("가".repeat(81)).mbti).toBe("INTP");
      expect(reason("철수는 동성애자인 것 같다")).not.toHaveProperty("mbti_reason");
      expect(reason("답장 늦는 걸 보니 내향형 확정, 회피형 성격이다").mbti_reason).toBe("답장 늦는 걸 보니 내향형 확정, 회피형 성격이다");
    });

    it("사람이 아닌 섹션(pair·group)과 빈 MBTI에는 MBTI가 없다(세지 않는다)", () => {
      const r = run(
        report([{ ...sec("둘", [para("p1", "저녁마다 이야기가 이어졌다")]), mbti: "ENFP", mbti_reason: "둘 다 즉흥형" }, person("민지", "", "이유만 있다")]),
      );
      for (const s of r.content!.sections) {
        expect(s).not.toHaveProperty("mbti");
        expect(s).not.toHaveProperty("mbti_reason");
      }
      expect(r.content?.checks?.dropped_by).toEqual({});
    });

    it("about에 범례 기호를 쓴 사람 섹션도 그 사람의 MBTI로 남긴다", () => {
      const code = memberCodes(members)[members.indexOf("철수")];
      const r = run(report([{ ...person("철수", "ESTP"), about: code }]));
      expect(r.content?.sections[0]).toMatchObject({ about: "철수", mbti: "ESTP" });
    });

    it("예전 모양 출력(chemistry·mbti 필드 없음)도 그대로 done이고, 저장한 섹션에 빈 MBTI 키가 없다", () => {
      const old = {
        safety: { flag: "none" },
        declined_topics: [],
        reading_notes: [],
        headline: "h",
        dek: "d",
        sections: [{ part: "nag_cards", icon: "🙄", title: "철수", about: "철수", paragraphs: [{ key: "p1", text: "철수는 저녁마다 짧게 답했다", evidence_ids: [] }], evidence: [] }],
      };
      const r = run(old);
      expect(r.status).toBe("done");
      expect(r.content).not.toHaveProperty("chemistry");
      expect(Object.keys(r.content!.sections[0]).sort()).toEqual(["about", "evidence", "icon", "paragraphs", "part", "title"]);
    });

    it("mbti가 문자열이 아니면(모양 오류) 그 섹션의 MBTI만 없고 리포트는 failed가 되지 않는다", () => {
      const r = run(report([{ ...person("철수", ""), mbti: 7 as unknown as string, mbti_reason: null as unknown as string }]));
      expect(r.status).toBe("done");
      expect(r.content?.sections[0]).not.toHaveProperty("mbti");
    });
  });

  it("truncated: 빠진 뒤쪽 필드에 기본값을 넣고, 결과는 partial", () => {
    const raw: Partial<Report> = report([sec("s", [para("p1", "저녁 대화가 이어져요")])]);
    delete raw.dek;
    expect(run(raw).status).toBe("failed");
    const r = run(raw, true);
    expect(r.status).toBe("partial");
    expect(r.content?.dek).toBe("");
    const head = { safety: { flag: "none" as const }, declined_topics: [] };
    expect(run(head, true).status).toBe("failed"); // 섹션 0개
    expect(run({ headline: "h" }, true).status).toBe("failed"); // safety 없음
    expect(run(null, true).status).toBe("failed");
  });
});
