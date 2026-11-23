// 개인정보 가리기: 링크·이메일·주민번호·전화번호·계좌를 [가림:…] 표시로 바꾼다. DOM 없이 브라우저·node 공용.
// 결과를 다시 넣어도 바뀌지 않는다(validatePayload가 이것으로 가리기 누락을 검사한다).

export type MaskKind = "phone" | "email" | "account" | "rrn" | "url";
export type MaskCounts = Record<MaskKind, number>;

const digitCount = (s: string) => s.replace(/\D/g, "").length;

/** 앞의 규칙이 먼저 가린다: 링크 속 이메일·숫자, 주민번호 속 전화번호 모양을 먼저 처리하려는 순서다 */
const RULES: { kind: MaskKind; re: RegExp; mark: string; accept?: (hit: string) => boolean }[] = [
  { kind: "url", re: /https?:\/\/[^\s<>"'＜＞]+|www\.[^\s<>"'＜＞]+/gi, mark: "[가림:링크]" },
  { kind: "email", re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, mark: "[가림:이메일]" },
  // 생년월일 6자리 + 성별 자리(1~8) + 6자리
  {
    kind: "rrn",
    re: /(?<!\d)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[- ]?[1-8]\d{6}(?!\d)/g,
    mark: "[가림:주민번호]",
  },
  // 휴대전화·지역번호·070, +82
  {
    kind: "phone",
    re: /(?<!\d)(?:\+82[- ]?|0)(?:1[016789]|2|[3-6][1-5]|70)[- .]?\d{3,4}[- .]?\d{4}(?!\d)/g,
    mark: "[가림:전화]",
  },
  // 하이픈으로 나뉜 숫자 묶음이나 이어진 숫자 중 숫자가 10~16자리인 것
  {
    kind: "account",
    re: /(?<![\d-])\d{2,6}(?:-\d{2,8}){1,4}(?![\d-])|(?<!\d)\d{10,16}(?!\d)/g,
    mark: "[가림:계좌]",
    accept: (hit) => digitCount(hit) >= 10 && digitCount(hit) <= 16,
  },
];

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
