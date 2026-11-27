// 데모 리포트(/demo)와 dev 미리보기가 쓰는 가짜 단톡방(v2.8). 실제 대화·실명이 아니다: 표시 이름은 test/fixtures/ALLOWED_NAMES의
// 테스트 이름(민지·철수·영희·지훈·수아)이고, 줄은 손으로 지은 짧은 말이다. 링크·전화·숫자 계좌 같은 가릴 것은 넣지 않는다.
// 시드가 같아 늘 같은 대화가 나온다. 사람마다 말버릇이 달라(ㅋ 길이·밤 활동·답장 속도·사진) 하이라이트 카드와 ㅋ 유형이 갈린다.
// 리포트가 인용하는 장면(SCENES)은 정해진 시각에 그대로 넣는다(근거 말풍선이 실제 메시지를 가리키게).
import type { ChatMessage } from "@/lib/parse/parse";

export const DEMO_NAMES = ["민지", "철수", "영희", "지훈", "수아"] as const;
export type DemoName = (typeof DEMO_NAMES)[number];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** KST 벽시계 → UTC epoch ms */
const kst = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h, mi) - 9 * HOUR;

/** 시드가 같으면 같은 수열을 내는 [0, 1) 난수(mulberry32) */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** 사람마다 말버릇: 말 거는 몫·말 많은 정도, ㅋ 길이 범위와 웃는 확률, 답장 간격(분), 사진 확률, 긴 메시지(50자 이상) 확률 */
interface Style {
  start: number;
  talk: number;
  laugh: [number, number];
  laughP: number;
  replyMin: [number, number];
  photoP: number;
  longP: number;
}
const STYLE: Record<DemoName, Style> = {
  민지: { start: 0.42, talk: 1.4, laugh: [5, 8], laughP: 0.55, replyMin: [0.5, 4], photoP: 0.03, longP: 0.06 },
  철수: { start: 0.18, talk: 1.0, laugh: [1, 2], laughP: 0.4, replyMin: [2, 15], photoP: 0.12, longP: 0.005 },
  영희: { start: 0.2, talk: 1.1, laugh: [10, 16], laughP: 0.5, replyMin: [1, 6], photoP: 0.04, longP: 0.02 },
  지훈: { start: 0.12, talk: 0.8, laugh: [3, 4], laughP: 0.35, replyMin: [3, 20], photoP: 0.05, longP: 0.01 },
  수아: { start: 0.08, talk: 0.6, laugh: [2, 3], laughP: 0.02, replyMin: [0.2, 1.5], photoP: 0.02, longP: 0 },
};

/** 사람마다 말끝 버릇(v2.9 대화 버릇)과 자주 꺼내는 말(자주 쓰는 단어). [붙일 말, 확률] */
const HABIT: Record<DemoName, [string, number][]> = {
  민지: [["!!", 0.3]],
  영희: [["~~", 0.25], ["😂", 0.1]],
  철수: [["...", 0.3]],
  지훈: [["ㄱㄱ", 0.2], ["OK", 0.1]],
  수아: [["ㅇㅇ", 0.35]],
};
const FLAVOR: Record<DemoName, string[]> = {
  민지: ["저녁 메뉴 투표하자", "맛집 리스트 공유할게", "드라마 정주행 각"],
  영희: ["이 노래 미쳤다", "노래 추천해 줄게", "연예 기사 봤어?"],
  철수: ["라면 먹을 사람", "야식 사진 투척", "라면 국물 최고"],
  지훈: ["주말 모임 어때", "여행 계획 짜자", "운동 끝나고 연락할게"],
  수아: ["일정 공유할게", "점심 메뉴 정했어", "날씨 확인해"],
};

/** 긴 메시지(v2.9 장문 장인). 숫자·링크 없음 */
const LONG_LINES = [
  "아 오늘 회의 진짜 길었는데 끝나고 나니까 배고파서 아무 생각도 안 나 저녁 뭐 먹지 다들 퇴근했어?",
  "주말에 날씨 좋다던데 다 같이 한강 가서 돗자리 깔고 치킨 시켜 먹는 거 어때 나 진짜 가고 싶어",
  "어제 그 드라마 마지막 장면 봤어? 나 진짜 소리 지를 뻔했잖아 다음 주까지 어떻게 기다리냐고",
];

/** 아무 말(물음표·호칭이 조금 섞인다) */
const LINES = [
  "오늘 뭐 해",
  "나 지금 퇴근",
  "배고프다",
  "치킨 어때",
  "아니 피자 먹자",
  "그거 봤어?",
  "봤지 완전 웃기던데",
  "주말에 뭐 해?",
  "나 토요일 비어",
  "일요일은 안 돼",
  "어디서 볼까",
  "거기 저번에 간 데",
  "헐 진짜?",
  "대박",
  "아 맞다",
  "언니 그거 어디서 샀어?",
  "형 내일 시간 돼?",
  "나 오늘 너무 피곤해",
  "회의 너무 길었어",
  "날씨 미쳤다",
  "우산 챙겨",
  "다들 잘 자",
  "아직 안 잤어?",
  "잠이 안 와",
  "내일 몇 시에 일어나",
  "그 노래 계속 듣는 중",
  "이거 완전 내 얘기",
  "누가 먼저 예약할래",
  "내가 할게",
  "고마워",
  "미안 늦었어",
  "지금 가는 중",
  "다 왔어",
  "사진 잘 나왔다",
  "이따 연락할게",
  "그래서 결론이 뭐야",
];

/** 리포트가 인용하는 장면(정해진 시각, 줄 그대로) */
export const SCENES: { at: number; sender: DemoName; text: string }[] = [
  { at: kst(2025, 3, 3, 19, 12), sender: "민지", text: "오늘 저녁 뭐 먹을까?" },
  { at: kst(2025, 3, 3, 19, 13), sender: "영희", text: `${"ㅋ".repeat(13)} 또 시작이다` },
  { at: kst(2025, 3, 3, 19, 20), sender: "수아", text: "아무거나" },
  { at: kst(2025, 4, 12, 21, 40), sender: "지훈", text: "주말에 다 같이 보자ㅋㅋㅋ" },
  { at: kst(2025, 4, 12, 21, 41), sender: "민지", text: "좋아좋아 ㅋㅋㅋㅋㅋㅋ 날짜는 누가 정해?" },
  { at: kst(2025, 5, 24, 2, 10), sender: "철수", text: "새벽 두 시에 라면 끓이는 사람 나야 나 ㅋ" },
  { at: kst(2025, 5, 24, 2, 11), sender: "영희", text: `아 진짜 ${"ㅋ".repeat(11)} 나도 먹고 싶어` },
  { at: kst(2025, 7, 19, 23, 58), sender: "영희", text: "아 그거 나도 들었어 대박이다 진짜로 어떻게 그런 일이 있지\n내일 자세히 얘기해 줘" },
  { at: kst(2025, 7, 19, 23, 59), sender: "수아", text: "ㅇㅇ 내일 점심에 말해 줄게" },
  { at: kst(2025, 8, 30, 20, 5), sender: "민지", text: "우리 다음 달에도 이렇게 떠들자" },
];

/** 2025-03-01부터 days일 동안의 가짜 단톡방(시간 순, id는 0부터) */
export function demoChat(days = 184): ChatMessage[] {
  const rand = random(20250301);
  // 긴 메시지(v2.9)를 낼지·어느 줄인지는 따로 굴린다
  const randLong = random(20250829);
  const randFlavor = random(20250830);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const between = ([lo, hi]: [number, number]) => lo + rand() * (hi - lo);
  /** 가중치(w)대로 한 사람 */
  const weighted = (w: (n: DemoName) => number, not?: DemoName): DemoName => {
    const pool = DEMO_NAMES.filter((n) => n !== not);
    const total = pool.reduce((s, n) => s + w(n), 0);
    let r = rand() * total;
    for (const n of pool) if ((r -= w(n)) < 0) return n;
    return pool[pool.length - 1];
  };
  const rows: { ts: number; sender: string; kind: ChatMessage["kind"]; text: string }[] = [];
  const start = kst(2025, 3, 1, 0, 0);
  for (let d = 0; d < days; d++) {
    // 하루 0~3번 대화가 열린다(주말엔 조금 더). 열리는 시각은 저녁·밤이 많고 새벽도 있다
    const weekend = new Date(start + d * DAY + 9 * HOUR).getUTCDay() % 6 === 0;
    const sessions = rand() < 0.08 ? 0 : 1 + Math.floor(rand() * (weekend ? 3 : 2.4));
    for (let k = 0; k < sessions; k++) {
      const hour = pick([8, 9, 12, 12, 13, 18, 19, 19, 20, 20, 21, 22, 23, 1]);
      let ts = start + d * DAY + hour * HOUR + Math.floor(rand() * 50) * MINUTE + k * 2 * HOUR;
      let who = weighted((n) => STYLE[n].start);
      const length = 6 + Math.floor(rand() * 34);
      for (let i = 0; i < length; i++) {
        const s = STYLE[who];
        if (rand() < s.photoP) rows.push({ ts, sender: who, kind: "photo", text: "사진" });
        else if (randLong() < s.longP) rows.push({ ts, sender: who, kind: "text", text: LONG_LINES[Math.floor(randLong() * LONG_LINES.length)] });
        else {
          const laugh = rand() < s.laughP ? `${"ㅋ".repeat(Math.round(between(s.laugh)))}` : "";
          // 버릇·자주 꺼내는 말(v2.9)도 따로 굴린다
          const base = pick(LINES);
          const flavored = randFlavor() < 0.18 ? FLAVOR[who][Math.floor(randFlavor() * FLAVOR[who].length)] : base;
          const line = HABIT[who].reduce((t, [tail, p]) => (randFlavor() < p ? `${t}${tail}` : t), flavored);
          rows.push({ ts, sender: who, kind: "text", text: laugh === "" ? line : rand() < 0.5 ? `${laugh} ${line}` : `${line} ${laugh}` });
        }
        // 다음 사람: 같은 사람이 이어 말할 때도 있다(말 많은 사람일수록)
        const next = rand() < 0.22 * STYLE[who].talk ? who : weighted((n) => STYLE[n].talk, who);
        ts += Math.max(1, Math.round(between(STYLE[next].replyMin))) * MINUTE;
        who = next;
      }
    }
  }
  for (const scene of SCENES) rows.push({ ts: scene.at, sender: scene.sender, kind: "text", text: scene.text });
  rows.sort((a, b) => a.ts - b.ts);
  return rows.map((r, id) => ({ id, ts: r.ts, sender: r.sender, kind: r.kind, text: r.text, line: id + 1 }));
}
