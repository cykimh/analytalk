import { describe, expect, it } from "vitest";
import { hasPII, linkMark, maskPII } from "./mask";

const ZERO = { phone: 0, email: 0, account: 0, rrn: 0, url: 0 };

describe("maskPII", () => {
  it("전화번호와 이메일을 하나씩 가리고 센다", () => {
    const r = maskPII("010-1234-5678 그리고 a@b.com");
    expect(r.counts).toEqual({ ...ZERO, phone: 1, email: 1 });
    expect(r.text).toBe("[가림:전화] 그리고 [가림:이메일]");
  });

  it.each([
    ["링크 https://example.com/a?b=c 봐", "링크 [링크:example.com] 봐", "url"],
    ["www.example.com 들어가", "[링크:example.com] 들어가", "url"],
    ["주민번호 900101-1234567", "주민번호 [가림:주민번호]", "rrn"],
    ["계좌 110-123-456789 로", "계좌 [가림:계좌] 로", "account"],
    ["3333-01-1234567 카뱅", "[가림:계좌] 카뱅", "account"],
    ["계좌 12345678901234", "계좌 [가림:계좌]", "account"],
    ["+82 10-1234-5678", "[가림:전화]", "phone"],
    ["01012345678로 전화", "[가림:전화]로 전화", "phone"],
    ["회사 02-123-4567", "회사 [가림:전화]", "phone"],
    ["회사 02)123-4567", "회사 [가림:전화]", "phone"],
    ["instagram.com/minji 팔로우해", "[링크:instagram.com] 팔로우해", "url"],
    ["open.kakao.com/o/abc 들어와", "[링크:open.kakao.com] 들어와", "url"],
    ["naver.me/xYz", "[링크:naver.me]", "url"],
    ["카드 1234 5678 9012 3456", "카드 [가림:계좌]", "account"],
    ["신한 110 123 456789", "신한 [가림:계좌]", "account"],
    ["카뱅 3333 01 1234567 로", "카뱅 [가림:계좌] 로", "account"],
    // 2글자 끝(so·me·io …)은 경로가 있거나 하위 도메인이 있으면 링크로 본다 (N4)
    ["notion.so/minji 봐", "[링크:notion.so] 봐", "url"],
    ["minji.github.io 블로그", "[링크:minji.github.io] 블로그", "url"],
    ["블로그 minji.tistory.com", "블로그 [링크:minji.tistory.com]", "url"],
    ["토스 1000 1234 5678", "토스 [가림:계좌]", "account"],
    // 영어 낱말이 아닌 2글자 끝(kr·io·co …)은 이름 하나만 붙어도 링크다. 여러 단계 끝(co.jp·co.uk)도 통째로 (M1)
    ["내 블로그 minji.kr 놀러와", "내 블로그 [링크:minji.kr] 놀러와", "url"],
    ["minji.co에 올렸어", "[링크:minji.co]에 올렸어", "url"],
    ["amazon.co.jp/x 에서 샀어", "[링크:amazon.co.jp] 에서 샀어", "url"],
    ["bbc.co.uk/news 봐", "[링크:bbc.co.uk] 봐", "url"],
    ["is.gd/abc 눌러", "[링크:is.gd] 눌러", "url"],
    ["op.gg 전적", "[링크:op.gg] 전적", "url"],
    // 영어 낱말이기도 한 끝(do·at·la)은 경로가 있으면 링크다: 짧은 주소 me2.do·shorturl.at·vo.la (M1)
    ["me2.do/abc 들어와", "[링크:me2.do] 들어와", "url"],
    ["shorturl.at/abc 들어와", "[링크:shorturl.at] 들어와", "url"],
    ["vo.la/abc 들어와", "[링크:vo.la] 들어와", "url"],
    // 날짜·시각 범위(월 1~12, 일 1~31, 시 0~23, 분 0~59)를 벗어난 연도 모양 숫자 묶음은 계좌로 본다 (M2)
    ["2012-34-56-78-90", "[가림:계좌]", "account"],
    ["1990 12 34 56 78", "[가림:계좌]", "account"],
    ["2024 12 34 56 78 90", "[가림:계좌] 90", "account"],
    ["2026 13 01 12 30", "[가림:계좌]", "account"],
    ["2026 10 00 12 30", "[가림:계좌]", "account"],
    ["2026-10-01-24-30", "[가림:계좌]", "account"],
    ["2026 10 01 12 60", "[가림:계좌]", "account"],
    // 마지막 묶음이 한 자리인 계좌(새마을금고 4-4-4-1, 3-4-4-2-1) (M3)
    ["새마을 9002-1234-5678-9 로 보내줘", "새마을 [가림:계좌] 로 보내줘", "account"],
    ["새마을 9002 1234 5678 9 로 보내줘", "새마을 [가림:계좌] 로 보내줘", "account"],
    ["신협 132-1234-5678-12-3", "신협 [가림:계좌]", "account"],
    // 뒤에 한 자리 숫자가 붙어도 전화번호는 전화번호다 (M3)
    ["010 1234 5678 9시에 전화해", "[가림:전화] 9시에 전화해", "phone"],
    // 카드 번호 뒤에 빈칸 두고 숫자가 붙어 16자리를 넘으면 뒤 묶음을 떼고 카드 번호만 가린다 (N1)
    ["카드 1234 5678 9012 3456 3개월 할부", "카드 [가림:계좌] 3개월 할부", "account"],
    ["1234 5678 9012 3456 5만원 결제했어", "[가림:계좌] 5만원 결제했어", "account"],
    ["카드 1234 5678 9012 3456 1장", "카드 [가림:계좌] 1장", "account"],
    ["카드 1234 5678 9012 3456 12개월 할부", "카드 [가림:계좌] 12개월 할부", "account"],
    ["카드 1234 5678 9012 3456 123", "카드 [가림:계좌] 123", "account"],
    ["카드 1234-5678-9012-3456-7", "카드 [가림:계좌]-7", "account"],
    // 날짜·시각 뒤의 계좌는 계좌만 가린다 (M2)
    ["2026 10 01 12 30 110 123 456789", "2026 10 01 12 30 [가림:계좌]", "account"],
    // 등록되지 않은 끝(nz·in·au …)이 co·com 뒤에 붙은 링크도 경로까지 통째로 가린다 (N2)
    ["abc.co.nz/minji", "[링크:abc.co.nz]", "url"],
    ["abc.co.in/minji", "[링크:abc.co.in]", "url"],
    ["abc.com.au/minji", "[링크:abc.com.au]", "url"],
    ["abc.com.br/minji 들어와", "[링크:abc.com.br] 들어와", "url"],
    ["가게 abc.com.sg 봐", "가게 [링크:abc.com.sg] 봐", "url"],
    // 끝 뒤에 붙은 것이 2글자 이름이 아니면 링크에 넣지 않는다 (N2)
    ["naver.com.html 열어", "[링크:naver.com].html 열어", "url"],
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
    // 영어 낱말이기도 한 끝(so·to·be·me·do)은 경로도 하위 도메인도 없으면 그대로, 낱말·파일 이름과 겹치는 끝은 넣지 않는다 (M1)
    "Let's go.To the park",
    "It may.Be true",
    "Just do it.Do it now",
    "Ok.No problem",
    "Thank you.It was fun",
    "README.md 고쳤어",
    "main.py 돌려봐",
    // 범위 안의 날짜·시각은 그대로 (M2)
    "1999-12-31-23-59",
    "2026 1 15 23 59 기록",
    "2026 10 01 00 00",
    "2026 10 01 12 30 45 기록",
    // 짧은 숫자, 한 자리 분으로 끝나는 날짜·시각 (M3)
    "1-2-3",
    "12-34-5 순서",
    "2026-10-01-12-5",
    "10 20 30 40 5 순서로",
    // 16자리를 넘는 숫자 줄이라도 계좌로 볼 앞부분이 없으면 그대로: 날짜·시각 두 개, 두 자리 묶음 (N1)
    "2026 10 01 12 30 2026 10 02 12 30",
    "10 20 30 40 50 60 70 순서로",
    "1999-12-31-23-59-30 기록",
  ])("개인정보가 아니면 그대로: %s", (s) => {
    expect(maskPII(s)).toEqual({ text: s, counts: ZERO });
  });

  it.each(["minji.kr", "minji.io", "minji.co", "minji.ly", "minji.gl", "minji.tv", "minji.gg", "minji.jp"])(
    "이름 하나만 붙은 2글자 끝 링크도 가린다: %s (M1)",
    (link) => {
      const r = maskPII(`${link} 블로그`);
      expect(r.text).toBe(`[링크:${link}] 블로그`);
      expect(r.counts).toEqual({ ...ZERO, url: 1 });
    },
  );

  it("한 번 가린 결과를 다시 가려도 바뀌지 않는다", () => {
    const once = maskPII("010-1234-56789 a@b.com https://x.kr 900101-1234567 1002-123-456789 youtu.be/abc 1234 5678 9012 3456");
    expect(once.text).not.toMatch(/\d{3}/);
    expect(maskPII(once.text)).toEqual({ text: once.text, counts: ZERO });
  });

  it("새로 가리는 모양(2글자 끝 링크·범위 밖 날짜 모양·한 자리 끝 계좌)도 다시 가려도 바뀌지 않는다", () => {
    const once = maskPII("minji.kr amazon.co.jp/x me2.do/abc 2012-34-56-78-90 2024 12 34 56 78 90 9002-1234-5678-9 9002 1234 5678 9");
    expect(once.text).not.toMatch(/\d{3}|\/x|\/abc/);
    expect(maskPII(once.text)).toEqual({ text: once.text, counts: ZERO });
  });

  it("카드 번호 두 개를 빈칸으로 이어 써도 둘 다 가린다 (N1)", () => {
    const r = maskPII("1234 5678 9012 3456 1111 2222 3333 4444");
    expect(r.text).toBe("[가림:계좌] [가림:계좌]");
    expect(r.counts).toEqual({ ...ZERO, account: 2 });
  });

  it("앞부분만 가린 계좌와 3단계 링크도 다시 가려도 바뀌지 않는다 (N1·N2)", () => {
    const once = maskPII(
      "카드 1234 5678 9012 3456 3개월 1234 5678 9012 3456 12개월 abc.co.nz/minji abc.com.au/minji",
    );
    expect(once.text).not.toMatch(/\d{3}|minji/);
    expect(maskPII(once.text)).toEqual({ text: once.text, counts: ZERO });
  });
});

describe("링크는 사이트 이름만 남긴다 (G3)", () => {
  it.each([
    ["https://example.com/a?b=c", "[링크:example.com]"],
    ["WWW.Example.COM", "[링크:example.com]"],
    ["https://a:b@x.com/", "[링크:x.com]"],
    ["https://x.com:8080/a#b", "[링크:x.com]"],
    ["naver.me/xYz", "[링크:naver.me]"],
    ["naver.com에서", "[링크:naver.com]에서"],
    ["http://192.168.0.1/a", "[가림:링크]"],
    ["https://한글.kr/", "[가림:링크]"],
    ["010-1234-5678.com", "[가림:링크]"],
  ])("%s → %s", (input, expected) => {
    const r = maskPII(input);
    expect(r.text).toBe(expected);
    expect(r.counts).toEqual({ ...ZERO, url: 1 });
  });

  it("linkMark는 던지지 않고 표시만 돌려준다", () => {
    expect(linkMark("https://Example.COM./a")).toBe("[링크:example.com]");
    expect(linkMark("https://")).toBe("[가림:링크]");
    expect(linkMark("https://%zz/")).toBe("[가림:링크]");
    expect(linkMark("https://a@b@x.com/")).toBe("[링크:x.com]");
  });

  it("이미 [링크:사이트] 표시인 조각은 다시 가리지 않는다", () => {
    expect(maskPII("[링크:youtube.com]")).toEqual({ text: "[링크:youtube.com]", counts: ZERO });
  });

  it("사용자가 직접 친 [링크:사이트/경로]의 경로는 새지 않는다", () => {
    const r = maskPII("[링크:instagram.com/minji]");
    expect(r.text).not.toContain("minji");
    expect(r.counts.url).toBe(1);
  });

  it("대문자 표시 조각은 소문자 표시로 바뀐다", () => {
    expect(maskPII("[링크:YouTube.com]").text).toBe("[링크:[링크:youtube.com]]");
  });

  it.each([
    "https://example.com/a?b=c",
    "WWW.Example.COM",
    "https://a:b@x.com/",
    "naver.me/xYz",
    "naver.com에서",
    "http://192.168.0.1/a",
    "https://한글.kr/",
    "010-1234-5678.com",
    "[링크:instagram.com/minji]",
    "[링크:YouTube.com] 와 youtube.com/x",
    "[링크:naver.me] 봐 naver.me/a 010-1234-5678",
  ])("다시 가려도 바뀌지 않는다: %s", (x) => {
    const once = maskPII(x).text;
    expect(maskPII(once)).toEqual({ text: once, counts: ZERO });
  });

  it("hasPII: 표시는 통과, 날 링크는 걸린다", () => {
    expect(hasPII("[링크:naver.me] 봐")).toBe(false);
    expect(hasPII("youtube.com 봐")).toBe(true);
  });
});
