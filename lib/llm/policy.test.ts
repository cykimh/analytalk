// v2.4 Fix 1: 표현 정책을 validateReport 단위로 고정한다(2026-11-27 사용자 "3번에서 막던 건 막지 말자").
// v2.4 Fix 2: 성적 지향·진단명의 맨 단정("철수는 게이다", "ADHD 같다")도 추측과 같이 지운다.
// 근거를 단 사람 문단 하나에 예문을 넣고, 저장되는지(남는지)만 본다.
// 남는 것: 속마음·호감·연애 감정 추측과 단정, 호감·케미 점수·순위, 놀림·디스·별명, 친구끼리 욕, 판결·역할 판정.
// 지워지는 것: 지어낸 따옴표 대사, 속성 비하(혐오·차별)·성적 묘사, 진단명 단정, 자해·폭력 부추김.
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/lib/parse/parse";
import { buildPayload, payloadIndex } from "@/lib/payload/build";
import { validateReport } from "./validate";

const kst = (d: number, h: number, mi: number) => Date.UTC(2026, 9, d, h, mi) - 9 * 3_600_000;
const rows: [string, number, string][] = [];
for (let d = 1; d <= 3; d++) {
  rows.push(
    ["철수", kst(d, 20, 0), "오늘 뭐해?"],
    ["민지", kst(d, 20, 5), "집에서 쉬는 중 ㅋㅋ"],
    ["철수", kst(d, 20, 6), "영화 볼래?\n내일 저녁"],
    ["민지", kst(d, 20, 10), "좋아!"],
  );
}
const messages: ChatMessage[] = rows.map(([sender, ts, text], id) => ({ id, ts, sender, kind: "text", text, line: id + 1 }));
const payload = buildPayload({ messages, tone: "detective", concept: "couple", kind: "pair", tokenBudget: 1_000_000, tokensPerChar: 1 });
const index = payloadIndex(payload);

/** 철수 섹션에 문단 하나(근거 m0)로 넣고 검증 뒤에 그 문단이 남는지 */
function kept(text: string): boolean {
  const raw = {
    safety: { flag: "none" },
    declined_topics: [],
    reading_notes: [{ range: "10-01~10-03", note: "저녁 대화" }],
    headline: "사건",
    dek: "보고서",
    sections: [
      {
        part: "case_brief",
        icon: "🔎",
        title: "개요",
        about: "pair",
        paragraphs: [{ key: "p1", text: "민지는 저녁마다 쉰다고 했다.", evidence_ids: ["e1"] }],
        evidence: [{ id: "e1", msg_id: "m1", quote: "쉬는 중" }],
      },
      {
        part: "case_people",
        icon: "🔎",
        title: "철수",
        about: "철수",
        paragraphs: [{ key: "p1", text, evidence_ids: ["e1"] }],
        evidence: [{ id: "e1", msg_id: "m0", quote: "오늘 뭐해?" }],
      },
    ],
  };
  const r = validateReport(raw, index, payload.stats, { truncated: false, tone: "detective", members: payload.members });
  return r.content?.sections.some((s) => s.about === "철수" && s.paragraphs.some((p) => p.text === text)) ?? false;
}

describe("표현 정책(v2.4 Fix 1·Fix 2)", () => {
  it.each([
    // 속마음·호감·연애 감정 추측과 단정
    "탐정의 결론: 철수는 민지를 좋아한다. 증거는 부족하지만 감은 확실하다.",
    "사실은 철수가 민지를 좋아한다. 탐정의 감이다.",
    "철수는 속으로는 민지를 좋아하는 게 분명하다.",
    "철수가 민지에게 관심이 있는 것 같다.",
    "철수는 민지한테 반했다. 틀려도 할 수 없다.",
    "철수는 서운한 것 같다. 답장이 짧아졌다.",
    "둘이 사귈 확률이 높다고 탐정은 본다.",
    // 호감·케미 점수와 순위
    "이 방 호감 순위 1위는 철수다.",
    "철수의 애정 지수는 만렙이다.",
    "철수와 민지의 케미 점수는 만점에 가깝다.",
    "케미 점수 10점 만점에 11점.",
    // 놀림·디스·별명, 친구끼리 욕
    "철수는 이 방 최고의 찌질이다.",
    "철수는 한심할 정도로 답이 늦다.",
    "철수 이 미친놈, 또 영화 얘기다.",
    "ㅅㅂ 이 방은 왜 맨날 영화 타령이냐.",
    // 판결·역할 판정
    "범인은 철수다.",
    "이 방의 실세는 민지다.",
    // 민감한 낱말이 주제로 나온 것, 관용구
    "철수가 우울증 관련 기사를 공유하자 방이 잠깐 조용해졌다.",
    "철수는 웃겨 죽겠다는 이모티콘만 보낸다.",
    "철수는 죽어라 영화만 고른다.",
    "철수는 회사 때려치우고 싶다는 말을 입에 달고 산다.",
    "철수는 영화에 목맨다.",
    "철수의 남자친구 얘기는 한 번도 나오지 않았다.",
    // 성적 지향·진단명이 주제로만 나온 것(사람에게 붙이지 않음)
    "철수가 동성애자 인권 기사를 공유했다.",
    "민지가 레즈비언 영화를 추천했다.",
    "철수는 프로 게이머다.",
    "철수의 체력 게이지가 바닥이다.",
    "철수가 ADHD 약 광고를 보고 웃었다.",
    "철수가 사이코패스 나오는 영화를 골랐다.",
    "둘은 우울증 관련 다큐를 같이 봤다.",
  ])("남는다: %s", (s) => {
    expect(kept(s)).toBe(true);
  });

  it.each([
    // ① 지어낸 따옴표 대사(원문에 없는 말)
    '철수는 "사랑해"라고 말했다.',
    '민지는 "너 없인 못 살아" 하고 답했다.',
    // ② 속성 비하(혐오·차별)·민감 속성 추측
    "여자라서 민지는 약속을 못 지킨다.",
    "철수는 전라도 출신이라 저렇게 답한다.",
    "철수는 장애인처럼 답장한다.",
    "철수는 게이 같아서 웃기다.",
    "민지는 동성애자인 것 같다.",
    "철수는 게이다.",
    "민지는 동성애자다.",
    "철수는 레즈비언이다.",
    "철수는 게이야.",
    "민지는 동성애자라서 답이 짧다.",
    "철수는 한남충 그 자체다.",
    "철수는 애자다.",
    // ② 성적인 묘사
    "둘은 영화 보고 침대에서 뜨거운 밤을 보낼 거다.",
    "철수는 민지의 몸매 얘기만 한다.",
    // ③ 진단명을 사실처럼
    "철수는 ADHD다.",
    "민지는 우울증이 있다.",
    "철수는 사이코패스가 분명하다.",
    "철수는 ADHD 같다.",
    "철수는 사이코패스 같다.",
    "철수는 ADHD라서 답이 늦다.",
    "철수는 소시오패스 확정이다.",
    "철수는 우울증 걸렸다.",
    "철수는 ADHD인 것 같다.",
    // ④ 자해·폭력 부추김
    "철수는 그냥 죽어 버려라.",
    "민지를 한 대 때려 줘야 정신을 차린다.",
    "철수는 자해라도 해야 정신 차린다.",
    // 글자로 쓴 퍼센트
    "철수가 대화를 연 비율은 70%다.",
  ])("지워진다: %s", (s) => {
    expect(kept(s)).toBe(false);
  });
});
