// 개인정보 가리기: 링크·이메일·주민번호·전화번호·계좌를 [가림:…] 표시로 바꾼다. DOM 없이 브라우저·node 공용.
// 결과를 다시 넣어도 바뀌지 않는다(validatePayload가 이것으로 가리기 누락을 검사한다).

export type MaskKind = "phone" | "email" | "account" | "rrn" | "url";
export type MaskCounts = Record<MaskKind, number>;

const digitCount = (s: string) => s.replace(/\D/g, "").length;
/** 숫자 묶음 중 가장 긴 것의 자리 수("10 20 30 40 50"처럼 두 자리씩 늘어놓은 것은 계좌로 보지 않는다) */
const longestGroup = (s: string) => Math.max(...s.split(/\D+/).map((g) => g.length));

/**
 * 머리(https://·www.) 없이 쓰는 링크의 끝(도메인). 이름 하나만 붙어도 링크로 본다:
 * instagram.com/x, open.kakao.com/o/x, minji.kr, minji.io, t.co/x, bit.ly/x, goo.gl/x, op.gg, is.gd/x, amazon.co.jp/x.
 * 영어 낱말과 겹치는 2글자 끝(it·is·in·my·no …)과 파일 확장자로 흔한 끝(md·py·sh·ai …)은 넣지 않는다
 */
const BARE_TLD = "com|net|org|app|link|page|kr|io|co|ly|gl|tv|gg|jp|cn|tw|hk|uk|de|fr|gd";
/**
 * 영어 낱말이기도 한 2글자 끝(naver.me/x, youtu.be/x, notion.so/x, kko.to/x, me2.do/x, shorturl.at/x, vo.la/x).
 * 경로(/…)가 붙거나 하위 도메인이 있을 때만 링크로 본다("I love you.So much"처럼 마침표 뒤에 이어 쓴 말은 둔다)
 */
const WORD_TLD = "so|to|be|me|do|at|la";
/** 링크의 호스트: min개 이상의 이름 + 끝(뒤에 글자·숫자·@·-가 이어지면 아니다) */
const host = (tld: string, min: number) => String.raw`(?:[a-z0-9-]+\.){${min},}(?:${tld})(?![a-z0-9@-])`;
const URL_PATH = String.raw`\/[^\s<>"'＜＞]*`;
/**
 * 빈칸·하이픈으로 나눈 날짜·시각: 4자리 연도 + 월(1~12) [+ 일(1~31) [+ 시(0~23) [+ 분(0~59) [+ 초(0~59)]]]]
 * ("2026 10 01 12 30"). 계좌로 보지 않는다. 범위를 벗어난 묶음("2012-34-56-78-90")은 날짜가 아니다
 */
const MONTH = String.raw`(?:0?[1-9]|1[0-2])`;
const DAY = String.raw`(?:0?[1-9]|[12]\d|3[01])`;
const HOUR = String.raw`(?:[01]?\d|2[0-3])`;
const MINUTE = String.raw`[0-5]?\d`;
const DATE_TIME = new RegExp(
  String.raw`^(?:19|20)\d{2}[- ]${MONTH}(?:[- ]${DAY}(?:[- ]${HOUR}(?:[- ]${MINUTE}(?:[- ]${MINUTE})?)?)?)?$`,
);

/** 앞의 규칙이 먼저 가린다: 링크 속 이메일·숫자, 주민번호 속 전화번호 모양을 먼저 처리하려는 순서다 */
const RULES: { kind: MaskKind; re: RegExp; mark: string; accept?: (hit: string) => boolean }[] = [
  { kind: "url", re: /https?:\/\/[^\s<>"'＜＞]+|www\.[^\s<>"'＜＞]+/gi, mark: "[가림:링크]" },
  { kind: "email", re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, mark: "[가림:이메일]" },
  // 머리 없는 링크. 이메일은 바로 앞 규칙이 먼저 가린다
  {
    kind: "url",
    re: new RegExp(
      String.raw`(?<![\w@.\/-])(?:${host(BARE_TLD, 1)}(?:${URL_PATH})?|${host(WORD_TLD, 2)}(?:${URL_PATH})?|${host(WORD_TLD, 1)}${URL_PATH})`,
      "gi",
    ),
    mark: "[가림:링크]",
  },
  // 생년월일 6자리 + 성별 자리(1~8) + 6자리
  {
    kind: "rrn",
    re: /(?<!\d)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[- ]?[1-8]\d{6}(?!\d)/g,
    mark: "[가림:주민번호]",
  },
  // 휴대전화·지역번호·070, +82
  {
    kind: "phone",
    re: /(?<!\d)(?:\+82[- ]?|0)(?:1[016789]|2|[3-6][1-5]|70)[- .)]?\d{3,4}[- .]?\d{4}(?!\d)/g,
    mark: "[가림:전화]",
  },
  // 하이픈·빈칸으로 나뉜 숫자 묶음이나 이어진 숫자 중 숫자가 10~16자리인 것(정산 메시지의 "110 123 456789", 카드 번호).
  // 마지막 묶음은 한 자리여도 된다(새마을금고 "9002-1234-5678-9", 3-4-4-2-1). 전화번호는 앞 규칙이 먼저 가린다.
  // 빈칸으로 나뉜 것은 세 자리 이상인 묶음이 하나는 있어야 한다. 연도로 시작하는 날짜·시각(DATE_TIME)은 둔다
  {
    kind: "account",
    re: /(?<![\d-])\d{2,6}(?:-\d{2,8}){0,3}-\d{1,8}(?![\d-])|(?<![\d-])\d{2,6}(?: \d{2,8}){0,3} \d{1,8}(?![\d-])|(?<!\d)\d{10,16}(?!\d)/g,
    mark: "[가림:계좌]",
    accept: (hit) =>
      digitCount(hit) >= 10 &&
      digitCount(hit) <= 16 &&
      (!hit.includes(" ") || longestGroup(hit) >= 3) &&
      !DATE_TIME.test(hit),
  },
];

/** 가릴 개인정보가 남아 있다(모델 출력 재검사용. 이미 가린 [가림:…] 표시는 다시 걸리지 않는다) */
export const hasPII = (text: string) => maskPII(text).text !== text;

/** 개인정보를 가린 본문과 종류별 개수. 더 가릴 것이 없을 때까지 되풀이한다 */
export function maskPII(text: string): { text: string; counts: MaskCounts } {
  const counts: MaskCounts = { phone: 0, email: 0, account: 0, rrn: 0, url: 0 };
  let out = text;
  // 가릴 때마다 숫자·@·링크 머리가 줄어들어 반드시 끝난다
  for (let changed = true; changed; ) {
    changed = false;
    for (const { kind, re, mark, accept } of RULES) {
      out = out.replace(re, (hit) => {
        if (accept && !accept(hit)) return hit;
        counts[kind]++;
        changed = true;
        return mark;
      });
    }
  }
  return { text: out, counts };
}
