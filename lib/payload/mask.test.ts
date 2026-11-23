import { describe, expect, it } from "vitest";
import { maskPII } from "./mask";
import { isSensitive } from "./sensitive";

const ZERO = { phone: 0, email: 0, account: 0, rrn: 0, url: 0 };

describe("maskPII", () => {
  it("전화번호와 이메일을 하나씩 가리고 센다", () => {
    const r = maskPII("010-1234-5678 그리고 a@b.com");
    expect(r.counts).toEqual({ ...ZERO, phone: 1, email: 1 });
    expect(r.text).toBe("[가림:전화] 그리고 [가림:이메일]");
  });

  it.each([
    ["링크 https://example.com/a?b=c 봐", "링크 [가림:링크] 봐", "url"],
    ["www.example.com 들어가", "[가림:링크] 들어가", "url"],
    ["주민번호 900101-1234567", "주민번호 [가림:주민번호]", "rrn"],
    ["계좌 110-123-456789 로", "계좌 [가림:계좌] 로", "account"],
    ["3333-01-1234567 카뱅", "[가림:계좌] 카뱅", "account"],
    ["계좌 12345678901234", "계좌 [가림:계좌]", "account"],
    ["+82 10-1234-5678", "[가림:전화]", "phone"],
    ["01012345678로 전화", "[가림:전화]로 전화", "phone"],
    ["회사 02-123-4567", "회사 [가림:전화]", "phone"],
  ])("%s → %s", (input, expected, kind) => {
    const r = maskPII(input);
    expect(r.text).toBe(expected);
    expect(r.counts).toEqual({ ...ZERO, [kind]: 1 });
  });

  it.each(["2024-03-14에 3만원", "오후 7:12 만나", "ㅋㅋㅋ 123번 버스", "10,000원 송금"])("개인정보가 아니면 그대로: %s", (s) => {
    expect(maskPII(s)).toEqual({ text: s, counts: ZERO });
  });

  it("한 번 가린 결과를 다시 가려도 바뀌지 않는다", () => {
    const once = maskPII("010-1234-56789 a@b.com https://x.kr 900101-1234567 1002-123-456789");
    expect(once.text).not.toMatch(/\d{3}/);
    expect(maskPII(once.text)).toEqual({ text: once.text, counts: ZERO });
  });
});

describe("isSensitive", () => {
  it.each(["어제 우울증 진단 받았어", "나 임신했대", "대출 이자 연체됐어", "걔 고소한대"])("민감: %s", (s) => {
    expect(isSensitive(s)).toBe(true);
  });

  it.each(["오늘 점심 뭐 먹지", "게이머 마우스 샀다", "ㅋㅋㅋ 내일 봐"])("민감 아님: %s", (s) => {
    expect(isSensitive(s)).toBe(false);
  });
});
