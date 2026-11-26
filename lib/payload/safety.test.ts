import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/lib/parse/parse";
import { BANNED_PATTERNS } from "./banned";
import { buildPayload, payloadIndex } from "./build";
import { safetySignal, sentSafetySignal } from "./safety";

let seq = 0;
function msg(text: string, sender: string | null = "P1"): ChatMessage {
  const id = seq++;
  return { id, ts: Date.UTC(2026, 9, 1) + id * 60_000, sender, kind: sender === null ? "system" : "text", text, line: id + 1 };
}

describe("safetySignal", () => {
  it("자해 사전에 걸리면 self_harm", () => {
    expect(safetySignal([msg("밥 먹었어?"), msg("요즘 너무 힘들어서 자살하고 싶어")])).toBe("self_harm");
    expect(safetySignal([msg("어제 손목 그었어")])).toBe("self_harm");
  });

  it("폭력 사전에 걸리면 violence, 둘 다면 self_harm이 먼저", () => {
    expect(safetySignal([msg("칼로 찌른다고 협박했어")])).toBe("violence");
    expect(safetySignal([msg("칼로 찌른다고 협박했어"), msg("자살하고 싶어")])).toBe("self_harm");
  });

  it("과장 표현과 시스템 메시지는 신호가 아니다", () => {
    expect(safetySignal([msg("배고파 죽겠다 ㅋㅋ"), msg("이 노래 진짜 죽인다"), msg("자살하고 싶어", null)])).toBeNull();
  });

  it.each([
    "과목 졸라 어려워",
    "발목 졸라 아파 ㅋㅋ",
    "제목 졸라 웃기네",
    "항목 졸라 많아",
    "목 졸라 아프다",
    "사유서 썼어",
    "시말서 대신 사유서 써",
    "거기선 살고 싶지 않아",
    "협박하냐 ㅋㅋㅋ",
    "협박하지마",
    "흉기 난동 뉴스 봄?",
    "흉기난동 뉴스 봤어?",
    "성추행 뉴스",
    "폭행했대 연예인",
    "칼로 찌르는 장면 영화",
  ])("친구 대화의 농담·뉴스 이야기는 신호가 아니다: %s", (text) => {
    expect(safetySignal([msg(text)])).toBeNull();
  });

  it.each([
    ["유서를 썼어", "self_harm"],
    ["더 이상 살고 싶지 않아", "self_harm"],
    ["목을 졸랐어", "violence"],
    ["흉기로 위협당했어", "violence"],
    ["어제 폭행 당했어", "violence"],
    ["협박당하고 있어", "violence"],
    ["성추행 당했어", "violence"],
  ])("행동·피해가 드러나면 신호다: %s", (text, kind) => {
    expect(safetySignal([msg(text)])).toBe(kind);
  });
});

describe("sentSafetySignal (보낼 메시지만 본다)", () => {
  const kst = (d: number, h: number) => Date.UTC(2026, 6, d, h) - 9 * 3_600_000;
  const rows = (texts: string[]): ChatMessage[] =>
    texts.map((text, id) => ({ id, ts: kst(1 + Math.floor(id / 4), 20) + (id % 4) * 60_000, sender: id % 2 ? "P2" : "P1", kind: "text", text, line: id + 1 }));

  it("페이로드에 실리지 않은 메시지(최근 구간·발췌 밖)의 신호는 보지 않는다", () => {
    const messages = rows(Array.from({ length: 300 }, (_, i) => (i === 150 ? "어제 자해 했어" : `평범한 이야기 ${i}`)));
    // 최근 구간만 실리는 작은 예산
    const p = buildPayload({ messages, me: "P1", concept: "couple", kind: "pair", tokenBudget: 2000, tokensPerChar: 1 });
    expect(payloadIndex(p).has("m150")).toBe(false);
    expect(safetySignal(messages)).toBe("self_harm");
    expect(sentSafetySignal(p, messages)).toBeNull();
  });

  it("실린 메시지에 신호가 있으면 알린다", () => {
    const messages = rows(["밥 먹었어?", "어제 자해 했어"]);
    const p = buildPayload({ messages, me: "P1", concept: "couple", kind: "pair", tokenBudget: 100_000, tokensPerChar: 1 });
    expect(sentSafetySignal(p, messages)).toBe("self_harm");
  });
});

describe("BANNED_PATTERNS", () => {
  const banned = (s: string) => BANNED_PATTERNS.some((re) => re.test(s));

  it.each([
    "속마음은 분명 당신을 좋아해요",
    "P2는 확실히 당신에게 관심이 있어요",
    "속으로 좋아하는 것 같다",
    "P2는 당신을 좋아하는 듯해요",
    "관심이 있는 것 같아요",
    "애정 지수는 85점이에요",
    "호감도 90",
    "연락할 확률이 높아요",
    "70%는 진심이에요",
    "우울증이 의심돼요",
    "전형적인 회피형 애착이에요",
    "ENFP다운 반응",
    "정치 성향이 보이네요",
    "종교가 있는 것 같아요",
    // 민감 속성 + 바로 붙은 추측·단정 꼬리, 건강 추측, 점수 문맥의 n/10
    "민지는 동성애자인 것 같아요",
    "임신한 것 같아요",
    "임신했나 봐요",
    "철수는 보수 성향이 확실해요",
    "기독교인 것 같아요",
    "아픈 것 같아요",
    "호감 8/10",
    // 같은 뜻의 다른 말투(D7)
    "관심이 있어 보여요",
    "민지를 좋아하나 봐요",
    "호감이 느껴져요",
    "서운해하는 것 같아요",
    "상대는 화가 난 것 같아요",
    "귀찮아하는 듯해요",
    "애정도가 높아요",
    "친밀도가 떨어졌어요",
    "서운해 보여요",
    "삐진 것 같아요",
    "설렌 것 같아요",
    "사랑이 느껴지는 대화예요",
    // 앞에 한글이 없는 화·짜증은 그대로 막는다 (N3)
    "화난 것 같아요",
    "P2는 화나 보여요",
    "상대가 짜증 난 것 같아요",
    "개짜증난 것 같아요",
  ])("걸린다: %s", (s) => {
    expect(banned(s)).toBe(true);
  });

  it.each([
    "답장은 빨라졌는데 질문은 줄었어요. 어떻게 느꼈나요?",
    "{{stat:share.P1}}만큼 대화를 먼저 열었어요",
    "밤 10시 이후에 대화가 몰려요",
    "사진 공유는 P2가 가장 많았어요",
    "둘 다 같은 노래를 좋아해서 링크가 자주 오갔어요",
    "P2가 좋아하는 것은 고양이 사진이에요",
    "저녁에 대화가 몰리는 것 같아요",
    "사진을 많이 보여줬어요",
    "일정이 있는 날은 대화가 짧아요",
    "기분 좋은 하루였던 것 같아요",
    "따뜻함이 느껴지는 인사예요",
    // 다른 말 속의 '화'(영화·전화)는 감정 말이 아니다 (N3)
    "주말엔 영화나 봐요",
    "전화나 봐",
    "영화나 보여 주자",
    // 민감한 낱말이 나와도 추측·단정이 아니라 원문 이야기를 전하는 것은 둔다
    "민지가 임신 소식을 전하자 축하가 쏟아졌어요",
    "일요일마다 교회 이야기가 나와요",
    "선거 날 투표 인증 사진이 올라왔어요",
    "철수가 병원 다녀온 얘기를 했어요",
    "불교 사찰 여행 사진이 공유됐어요",
    "민주당 이야기로 단톡이 시끄러웠던 날",
    "3/10에 만났어요",
  ])("안 걸린다: %s", (s) => {
    expect(banned(s)).toBe(false);
  });

  it("test()가 상태를 갖지 않도록 g·y 플래그를 쓰지 않는다", () => {
    expect(BANNED_PATTERNS.length).toBeGreaterThan(0);
    for (const re of BANNED_PATTERNS) expect(re.flags).not.toMatch(/[gy]/);
  });
});
