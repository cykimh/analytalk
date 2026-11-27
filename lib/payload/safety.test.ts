import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/lib/parse/parse";
import { BANNED_PATTERNS } from "./banned";
import { buildPayload, payloadIndex } from "./build";
import { dropSafetyFlagged, safetyKind } from "./safety";

let seq = 0;
function msg(text: string, sender: string | null = "P1"): ChatMessage {
  const id = seq++;
  return { id, ts: Date.UTC(2026, 9, 1) + id * 60_000, sender, kind: sender === null ? "system" : "text", text, line: id + 1 };
}

describe("safetyKind", () => {
  const kindOf = (text: string, sender: string | null = "P1") => safetyKind(msg(text, sender));

  it("자해 사전에 걸리면 self_harm", () => {
    expect(kindOf("요즘 너무 힘들어서 자살하고 싶어")).toBe("self_harm");
    expect(kindOf("어제 손목 그었어")).toBe("self_harm");
    expect(kindOf("밥 먹었어?")).toBeNull();
  });

  it("폭력 사전에 걸리면 violence, 둘 다면 self_harm이 먼저", () => {
    expect(kindOf("칼로 찌른다고 협박했어")).toBe("violence");
    expect(kindOf("칼로 찌른다고 협박했어, 자살하고 싶어")).toBe("self_harm");
  });

  it("과장 표현과 시스템 메시지는 신호가 아니다", () => {
    expect(kindOf("배고파 죽겠다 ㅋㅋ")).toBeNull();
    expect(kindOf("이 노래 진짜 죽인다")).toBeNull();
    expect(kindOf("자살하고 싶어", null)).toBeNull();
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
    expect(kindOf(text)).toBeNull();
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
    expect(kindOf(text)).toBe(kind);
  });
});

describe("dropSafetyFlagged (막지 않고 그 메시지만 뺀다)", () => {
  const kst = (d: number, h: number) => Date.UTC(2026, 6, d, h) - 9 * 3_600_000;
  const rows = (texts: string[]): ChatMessage[] =>
    texts.map((text, id) => ({ id, ts: kst(1 + Math.floor(id / 4), 20) + (id % 4) * 60_000, sender: id % 2 ? "P2" : "P1", kind: "text", text, line: id + 1 }));

  it("걸린 메시지만 빼고 개수를 센다. 나머지의 id·순서·본문은 그대로", () => {
    const messages = rows(["밥 먹었어?", "어제 자해 했어", "응 먹었어", "칼로 찌른다고 협박했어", "내일 봐"]);
    const r = dropSafetyFlagged(messages);
    expect(r.dropped).toBe(2);
    expect(r.messages).toEqual([messages[0], messages[2], messages[4]]);
  });

  it("뺀 메시지는 페이로드(anchors·transcript) 어디에도 없다", () => {
    const messages = rows(Array.from({ length: 40 }, (_, i) => (i === 7 ? "어제 자해 했어" : `평범한 이야기 ${i}`)));
    const r = dropSafetyFlagged(messages);
    const p = buildPayload({ messages: r.messages, tone: "fact", concept: "couple", kind: "pair", tokenBudget: 100_000, tokensPerChar: 1 });
    expect(payloadIndex(p).has("m7")).toBe(false);
    expect(payloadIndex(p).has("m8")).toBe(true);
    expect(`${p.anchors}\n${p.transcript}`).not.toContain("자해");
  });

  it("시스템 메시지·미디어는 보지 않고 그대로 둔다", () => {
    const system: ChatMessage = { id: 0, ts: 0, sender: null, kind: "system", text: "자살하고 싶어", line: 1 };
    const photo: ChatMessage = { id: 1, ts: 0, sender: "P1", kind: "photo", text: "자살하고 싶어", line: 2 };
    expect(dropSafetyFlagged([system, photo])).toEqual({ messages: [system, photo], dropped: 0 });
  });

  it("입력은 바꾸지 않는다", () => {
    const messages = rows(["어제 자해 했어", "응"]);
    dropSafetyFlagged(messages);
    expect(messages).toHaveLength(2);
  });
});

describe("BANNED_PATTERNS", () => {
  const banned = (s: string) => BANNED_PATTERNS.some((re) => re.test(s));

  // v2.5: 막는 것은 ① 혐오·차별 ② 자해·폭력 부추김 ③ 성적 묘사 ④ 성적 지향 단정·추측, 그리고 글자로 쓴 %뿐이다
  it.each([
    "70%는 진심이에요",
    // ④ 성적 지향 단정·추측(리뷰 I2: 추측·질문·소문 꼴도)
    "민지는 동성애자인 것 같아요",
    "철수는 게이다",
    "철수는 게이일지도 모른다",
    "철수는 동성애자일 수도 있다",
    "철수는 게이임이 틀림없다",
    "철수는 게이라는 소문이 있다",
    "레즈일 확률이 높다",
    "혹시 게이?",
    "게이 아니냐",
    "커밍아웃 각",
    "곧 커밍아웃할 듯",
    // 속성 비하(행동의 이유로 대기·견주기)와 혐오 낱말
    "여자라서 약속을 못 지킨다",
    "남자니까 저렇지",
    "전라도 출신이라 저렇게 답한다",
    "서울 출신이라 그런지",
    "장애인처럼 답장한다",
    "게이 같아서 웃기다",
    "외국인이라서 말이 짧다",
    "김치녀 소리 듣겠다",
    "틀딱 같은 답장",
    // 성적인 묘사(리뷰 I3)
    "침대에서 뜨거운 밤을 보낼 거다",
    "야한 얘기만 한다",
    "성관계 얘기",
    "몸매가 섹시하다",
    "몸매가 야하다",
    "가슴이 크다",
    "엉덩이가 탐스럽다",
    "허벅지가 예쁘다",
    "둘이 잤다",
    "같이 잤어",
    "덮치고 싶어 한다",
    "벗은 몸",
    // 자해·폭력 부추김
    "그냥 죽어 버려라",
    "죽어라.",
    "한 대 때려 줘야 정신을 차린다",
    "자해라도 해야 정신 차린다",
    "자살해 버려",
    "패 버려야 한다",
    "죽여 버릴까",
  ])("걸린다: %s", (s) => {
    expect(banned(s)).toBe(true);
  });

  it.each([
    "답장은 빨라졌는데 질문은 줄었어요. 어떻게 느꼈나요?",
    "{{stat:share.P1}}만큼 대화를 먼저 열었어요",
    "밤 10시 이후에 대화가 몰려요",
    "둘 다 같은 노래를 좋아해서 링크가 자주 오갔어요",
    "주말엔 영화나 봐요",
    "3/10에 만났어요",
    // 민감한 낱말이 나와도 추측·단정이 아니라 원문 이야기를 전하는 것은 둔다
    "민지가 임신 소식을 전하자 축하가 쏟아졌어요",
    "일요일마다 교회 이야기가 나와요",
    "선거 날 투표 인증 사진이 올라왔어요",
    "불교 사찰 여행 사진이 공유됐어요",
    "민주당 이야기로 단톡이 시끄러웠던 날",
    "우울증 관련 기사를 공유했다",
    "ADHD 다큐를 같이 봤다는 얘기",
    "남자친구 얘기가 자주 나온다",
    "통신 장애처럼 답이 끊긴다",
    "이 반의 분위기 반장은 민지예요",
    // 관용구
    "웃겨 죽겠다",
    "죽어라 공부만 한다",
    "회사 때려치우고 싶다",
    "영화에 목맨다",
    "자위대 뉴스",
    // v2.4 Fix 1: 속마음·호감 단정, 점수·순위, 놀림·욕, 판정은 막지 않는다(틀려도 된다)
    "속마음은 분명 당신을 좋아해요",
    "P2는 당신을 좋아하는 듯해요",
    "사실은 P2를 좋아한다",
    "민수는 사실 으리를 좋아한다",
    "알고 보면 P1은 P2에게 관심이 있다",
    "사귈 확률이 높다",
    "상대는 화가 난 것 같아요",
    "삐진 것 같아요",
    "애정 지수는 85점이에요",
    "호감도 90",
    "호감 8/10",
    "100점 만점에 120점",
    "호감 순위 1위",
    "ENFP다운 반응",
    "철수는 이 방 최고의 찌질이다",
    "한심할 정도로 답이 늦다",
    "이 미친놈",
    "ㅅㅂ 또 영화냐",
    "이 방의 실세는 창엽이다",
    "범인은 민수다",
    "민수가 범인일 확률이 매우 높다",
    "이 무리의 우두머리는 민수다",
    // v2.5: 진단명·성격 유형 붙이기, 외모 놀림, 임신·종교·정치·건강 추측도 막지 않는다
    "우울증이 의심돼요",
    "철수는 ADHD다",
    "민지는 우울증이 있다",
    "철수는 사이코패스가 분명하다",
    "자폐인 것 같다",
    "철수는 누가 봐도 ENFP다",
    "몸매 얘기만 한다",
    "몸매가 엉망이다",
    "얼굴이 감자처럼 생겼다",
    "가슴이 답답하다",
    "태풍이 덮쳤다",
    "커밍아웃 기사를 공유했다",
    "게이 친구 얘기",
    "게이머다",
    "정치 성향이 보이네요",
    "종교가 있는 것 같아요",
    "임신한 것 같아요",
    "임신했나 봐요",
    "철수는 보수 성향이 확실해요",
    "기독교인 것 같아요",
  ])("안 걸린다: %s", (s) => {
    expect(banned(s)).toBe(false);
  });

  it("test()가 상태를 갖지 않도록 g·y 플래그를 쓰지 않는다", () => {
    expect(BANNED_PATTERNS.length).toBeGreaterThan(0);
    for (const re of BANNED_PATTERNS) expect(re.flags).not.toMatch(/[gy]/);
  });
});
