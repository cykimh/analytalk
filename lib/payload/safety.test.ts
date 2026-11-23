import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/lib/parse/parse";
import { BANNED_PATTERNS } from "./banned";
import { safetySignal } from "./safety";

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
});

describe("BANNED_PATTERNS", () => {
  const banned = (s: string) => BANNED_PATTERNS.some((re) => re.test(s));

  it.each([
    "속마음은 분명 당신을 좋아해요",
    "P2는 확실히 당신에게 관심이 있어요",
    "애정 지수는 85점이에요",
    "호감도 90",
    "연락할 확률이 높아요",
    "70%는 진심이에요",
    "우울증이 의심돼요",
    "전형적인 회피형 애착이에요",
    "ENFP다운 반응",
    "정치 성향이 보이네요",
    "종교가 있는 것 같아요",
  ])("걸린다: %s", (s) => {
    expect(banned(s)).toBe(true);
  });

  it.each([
    "답장은 빨라졌는데 질문은 줄었어요. 어떻게 느꼈나요?",
    "{{stat:share.P1}}만큼 대화를 먼저 열었어요",
    "밤 10시 이후에 대화가 몰려요",
    "사진 공유는 P2가 가장 많았어요",
  ])("안 걸린다: %s", (s) => {
    expect(banned(s)).toBe(false);
  });

  it("test()가 상태를 갖지 않도록 g·y 플래그를 쓰지 않는다", () => {
    expect(BANNED_PATTERNS.length).toBeGreaterThan(0);
    for (const re of BANNED_PATTERNS) expect(re.flags).not.toMatch(/[gy]/);
  });
});
