import { describe, expect, it } from "vitest";
import { validateReport } from "@/lib/llm/validate";
import { buildPayload, payloadIndex } from "@/lib/payload/build";
import { habitTable, unansweredRows, wordRows } from "@/lib/stats/details";
import { highlightCards } from "@/lib/stats/highlights";
import { titleCards } from "@/lib/stats/titles";
import { laughType } from "@/lib/stats/laughType";
import { ALLOWED_NAMES } from "@/scripts/check-fixtures";
import { DEMO_NAMES, SCENES } from "./chat";
import { demoMessages, demoNames, demoReport, demoStats } from "./report";

describe("데모 리포트(v2.8 /demo)", () => {
  it("표시 이름은 테스트용 이름(ALLOWED_NAMES)뿐이고, 메시지 많은 순이다", () => {
    for (const name of DEMO_NAMES) expect(ALLOWED_NAMES).toContain(name);
    expect(Object.keys(demoStats.byPerson).sort()).toEqual([...DEMO_NAMES].sort());
    const counts = demoNames.map((n) => demoStats.byPerson[n]);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it("가짜 대화는 늘 같다(시드 고정)이고 리포트가 인용하는 장면이 그대로 들어 있다", () => {
    expect(demoMessages.length).toBeGreaterThan(3000);
    for (const scene of SCENES) {
      expect(demoMessages.some((m) => m.sender === scene.sender && m.text === scene.text && m.ts === scene.at)).toBe(true);
    }
  });

  it("손으로 쓴 리포트가 저장 전 검증을 그대로 통과한다: 근거·따옴표 대사가 실제 메시지이고, 자리표시자가 풀리고, 지우는 것이 없다", () => {
    const payload = buildPayload({ messages: demoMessages, tone: "fact", concept: "group", kind: "group", tokenBudget: 10_000_000, tokensPerChar: 1 });
    expect(payload.msgSent).toBe(payload.msgTotal);
    const raw = {
      ...demoReport,
      sections: demoReport.sections.map(({ evidence, mbti = "", mbti_reason = "", persona, ...s }) => ({
        ...s,
        mbti,
        mbti_reason,
        // 모델 출력 모양: 명대사는 번호·원문만
        persona: persona ? { ...persona, quotes: persona.quotes.map(({ msg_id, quote }) => ({ msg_id, quote })) } : null,
        evidence: evidence.map(({ id, msg_id, quote }) => ({ id, msg_id, quote })),
      })),
    };
    const r = validateReport(raw, payloadIndex(payload), payload.stats, { truncated: false, tone: "fact", members: payload.members });
    expect(r.status).toBe("done");
    expect(r.dropped).toMatchObject({ paragraphs: 0, evidence: 0 });
    expect(r.content?.checks).toEqual({ relinked: 0, requoted: 0, unquoted: 0, dropped_by: {} });
    expect(r.content?.chemistry).toEqual(demoReport.chemistry);
    expect(r.content?.sections.map((s) => s.evidence)).toEqual(demoReport.sections.map((s) => s.evidence));
    expect(r.content?.sections.map((s) => s.mbti ?? null)).toEqual(demoReport.sections.map((s) => s.mbti ?? null));
    // v2.9: 페르소나(명대사 포함)와 관계 카드가 검증 뒤에도 그대로다
    expect(r.content?.sections.map((s) => s.persona ?? null)).toEqual(demoReport.sections.map((s) => s.persona ?? null));
    expect(r.content?.relationship).toEqual(demoReport.relationship);
    expect(r.content?.sections.flatMap((s) => s.paragraphs.map((p) => p.text))).toEqual(demoReport.sections.flatMap((s) => s.paragraphs.map((p) => p.text)));
  });

  it("v2.9: 칭호 여섯과 숫자 부록(읽씹·버릇·단어)이 모두 나오고, 자주 쓰는 단어에 숫자·링크가 없다", () => {
    expect(titleCards(demoStats).map((t) => t.key)).toEqual(["obsessed", "speedy", "ghost", "laugh", "essay", "owl"]);
    expect(unansweredRows(demoStats).length).toBe(5);
    expect(habitTable(demoStats).people).toHaveLength(4);
    expect(wordRows(demoStats).map((w) => w.words.length)).toEqual([10, 10, 10, 10, 10]);
    for (const w of wordRows(demoStats)) for (const [word] of w.words) expect(word).toMatch(/^(?:[가-힣]+|[a-z]+)$/);
  });

  it("하이라이트 카드 6장(케미 온도부터)과 사람마다 다른 ㅋ 유형이 보인다", () => {
    const cards = highlightCards(demoStats, { chemistry: demoReport.chemistry });
    expect(cards).toHaveLength(6);
    expect(cards[0]).toMatchObject({ key: "chemistry", value: "87°" });
    const types = DEMO_NAMES.map((n) => laughType(demoStats.laughLength[n], demoStats.byPerson[n]));
    expect(new Set(types)).toEqual(new Set(["deadpan", "restrained", "classic", "burst", "maniac"]));
    // 사람 섹션 다섯 개가 모두 MBTI 추측을 단다
    expect(demoReport.sections.filter((s) => s.mbti).map((s) => s.about).sort()).toEqual([...DEMO_NAMES].sort());
  });
});
