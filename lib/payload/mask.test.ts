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
    ["회사 02)123-4567", "회사 [가림:전화]", "phone"],
    ["instagram.com/minji 팔로우해", "[가림:링크] 팔로우해", "url"],
    ["open.kakao.com/o/abc 들어와", "[가림:링크] 들어와", "url"],
    ["naver.me/xYz", "[가림:링크]", "url"],
    ["카드 1234 5678 9012 3456", "카드 [가림:계좌]", "account"],
    ["신한 110 123 456789", "신한 [가림:계좌]", "account"],
    ["카뱅 3333 01 1234567 로", "카뱅 [가림:계좌] 로", "account"],
    // 2글자 끝(so·me·io …)은 경로가 있거나 하위 도메인이 있으면 링크로 본다 (N4)
    ["notion.so/minji 봐", "[가림:링크] 봐", "url"],
    ["minji.github.io 블로그", "[가림:링크] 블로그", "url"],
    ["블로그 minji.tistory.com", "블로그 [가림:링크]", "url"],
    ["토스 1000 1234 5678", "토스 [가림:계좌]", "account"],
  ])("%s → %s", (input, expected, kind) => {
    const r = maskPII(input);
    expect(r.text).toBe(expected);
    expect(r.counts).toEqual({ ...ZERO, [kind]: 1 });
  });

  it.each([
    "2024-03-14에 3만원",
    "오후 7:12 만나",
    "ㅋㅋㅋ 123번 버스",
    "10,000원 송금",
    "2024 03 14 모임",
    "10 20 30 40 50 순서로",
    "node.js 공부",
    "3.5배 빨라",
    // 문장 끝 마침표 뒤에 빈칸 없이 이어 쓴 말, 빈칸으로 나눈 날짜·시각 (N4)
    "I love you.So much",
    "Thank you.Me too",
    "2026 10 01 12 30",
    "출발 2026 10 01 12 30 이야",
    "2026-10-01-12-30 기록",
  ])("개인정보가 아니면 그대로: %s", (s) => {
    expect(maskPII(s)).toEqual({ text: s, counts: ZERO });
  });

  it("한 번 가린 결과를 다시 가려도 바뀌지 않는다", () => {
    const once = maskPII("010-1234-56789 a@b.com https://x.kr 900101-1234567 1002-123-456789 youtu.be/abc 1234 5678 9012 3456");
    expect(once.text).not.toMatch(/\d{3}/);
    expect(maskPII(once.text)).toEqual({ text: once.text, counts: ZERO });
  });
});

describe("isSensitive", () => {
  it.each(["어제 우울증 진단 받았어", "나 임신했대", "대출 이자 연체됐어", "걔 고소한대", "고소장 냈어", "전과 있대", "기소됐대", "유산했대"])("민감: %s", (s) => {
    expect(isSensitive(s)).toBe(true);
  });

  it.each([
    "오늘 점심 뭐 먹지",
    "게이머 마우스 샀다",
    "ㅋㅋㅋ 내일 봐",
    "예전과 달라",
    "이전과 같아",
    "전과목 다 봤어",
    "자기소개서 썼어",
    "유산소 하러 감",
    "유산균 먹어",
    "문화유산 답사",
    "고소해 맛있어",
    "참기름이 고소한 냄새",
    "고소공포증 있어",
  ])("민감 아님: %s", (s) => {
    expect(isSensitive(s)).toBe(false);
  });
});
