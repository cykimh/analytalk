// 테스트용 가짜 단톡방. 이름 정리를 마친 메시지(표시 이름 "멤버01"…)라 실제 이름·대화는 들어 있지 않다.
import type { ChatMessage } from "@/lib/parse/parse";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// 길이·물음표·웃음·호칭·링크가 섞이게 고른 줄
const LINES = [
  "오늘 저녁 뭐 먹을까?",
  "ㅋㅋㅋㅋ 진짜 웃기다",
  "형 내일 시간 돼?",
  "사진 잘 봤어",
  "https://example.com/a 이거 봐봐",
  "언니 고마워요 덕분에 살았어요",
  "회의 끝나고 연락할게",
  "주말에 다 같이 보자ㅎㅎ",
  "응",
  "아 그거 나도 들었어 대박이다 진짜로 어떻게 그런 일이 있지",
];

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

/** i번째 사람의 표시 이름 */
export const memberName = (i: number) => `멤버${String(i + 1).padStart(2, "0")}`;

/**
 * people명이 months개월(start년 1월부터, KST) 동안 달마다 메시지를 보내는 가짜 단톡방.
 * 사람마다 달마다 보내는 수가 다르다(1~people개, 이름 순서와 섞인 순서). id는 시각 순서다
 */
export function syntheticGroupChat(people: number, months: number, start = 2021): ChatMessage[] {
  const rand = random(people * 1000 + months);
  // 0, n-1, 1, n-2, …: 이름 순서와 메시지 수 순서가 다르게
  const perMonth = (i: number) => 1 + (i % 2 === 0 ? i / 2 : people - 1 - (i - 1) / 2);
  const rows: { sender: string; ts: number; text: string; kind: ChatMessage["kind"] }[] = [];
  for (let m = 0; m < months; m++) {
    const monthStart = Date.UTC(start, m, 1) - 9 * HOUR;
    for (let i = 0; i < people; i++) {
      for (let k = 0; k < perMonth(i); k++) {
        const n = rows.length;
        const kind: ChatMessage["kind"] = n % 9 === 0 ? "photo" : n % 13 === 0 ? "emoticon" : "text";
        rows.push({
          sender: memberName(i),
          ts: monthStart + Math.floor(rand() * 28 * DAY),
          text: kind === "text" ? LINES[Math.floor(rand() * LINES.length)] : "",
          kind,
        });
      }
    }
  }
  rows.sort((a, b) => a.ts - b.ts);
  return rows.map((r, id) => ({ id, ts: r.ts, sender: r.sender, kind: r.kind, text: r.text, line: id + 1 }));
}

// ===== v2.7 측정용: 몰아 보내는 단톡방 =====

/** 글 메시지(2~40자, 평균 약 12자). 숫자·링크가 없어 가리기에 걸리지 않는다 */
const BURSTY_TEXTS = [
  "오늘 저녁 뭐 먹을까?",
  "나 지금 퇴근",
  "헐",
  "대박",
  "진짜?",
  "아 배고파",
  "치킨 시켜",
  "아니 피자 먹자",
  "그거 어제 나온 거 봤어?",
  "봤지 완전 웃기던데",
  "회의 너무 길어서 죽을 뻔",
  "주말에 다 같이 보자",
  "어디서 볼까",
  "강남 어때",
  "난 홍대가 편한데",
  "그럼 홍대로 하자",
  "몇 시에?",
  "일곱 시쯤",
  "콜",
  "나 늦을 수도 있음",
  "또 늦냐",
  "미안 진짜 이번엔 일찍 갈게",
  "아 맞다 그거 어떻게 됐어?",
  "아직 연락 없어",
  "기다려 봐 곧 오겠지",
  "오늘 날씨 미쳤다 너무 더워",
  "에어컨 틀었어?",
  "우리 집 에어컨 고장 났어",
  "헐 어떡해",
  "그래서 카페 와 있음",
  "부럽다 나도 갈래",
  "와 이거 봐",
  "이거 너무 귀엽다\n완전 내 스타일",
  "누가 먼저 말 좀 해 봐",
  "다들 자?",
  "나 아직 안 잠",
  "내일 출근 어떻게 하냐",
  "그러니까 벌써 일요일 밤이야",
  "다음 주에 휴가 쓰려고",
  "어디 가는데?",
  "제주도 갈까 생각 중",
  "좋겠다 맛있는 거 많이 먹고 와",
];
/** 자모·기호만 있는 짧은 반응 */
const BURSTY_REACTIONS = ["ㅋㅋ", "ㅋㅋㅋ", "ㅋㅋㅋㅋㅋ", "ㅎㅎ", "ㅇㅇ", "ㅠㅠ", "ㄷㄷ", "ㄱㄱ", "ㅇㅋ", "?", "!!", "ㅜㅜ"];

/**
 * 몰아 보내는 가짜 단톡방(카톡 텍스트 내보내기처럼 분 단위 시각, KST). 시드가 같으면 같은 대화다.
 * - 하루에 대화 판 0~3개(평균 1.5), 판마다 차례 6~40번. 차례마다 한 사람이 메시지를 1개(50%)·2개(20%)·3개(12%)·4개(8%)·5~8개(10%) 보낸다
 * - 차례 안에서는 같은 분이 이어지고, 메시지마다 25%로 다음 분으로 넘어간다. 차례 사이는 0분(30%)·1분(40%)·2~5분(30%)
 * - 다음 차례는 85%로 다른 사람이다. 말 많은 사람과 적은 사람이 있다(무게 1/(순번+1)^0.7)
 * - 종류: 글 70%, 짧은 반응 18%(ㅋㅋ·ㅇㅇ·ㅠㅠ…), 사진 6%, 이모티콘 5%, 동영상 1%
 * - 가끔(차례의 0.2%) 들어옴 알림(시스템 메시지)이 끼어 메시지 번호가 건너뛴다
 */
export function syntheticBurstyChat(opts: { people?: number; days?: number; start?: number; seed?: number } = {}): ChatMessage[] {
  const { people = 8, days = 400, start = 2023, seed = 27 } = opts;
  const rand = random(seed * 7919 + people * 31 + days);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const weights = Array.from({ length: people }, (_, i) => 1 / (i + 1) ** 0.7);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const weighted = () => {
    let r = rand() * totalWeight;
    for (let i = 0; i < people; i++) if ((r -= weights[i]) < 0) return i;
    return people - 1;
  };
  const burstSize = () => {
    const r = rand();
    return r < 0.5 ? 1 : r < 0.7 ? 2 : r < 0.82 ? 3 : r < 0.9 ? 4 : 5 + Math.floor(rand() * 4);
  };
  const out: ChatMessage[] = [];
  const push = (m: Omit<ChatMessage, "id" | "line">) => out.push({ ...m, id: out.length, line: out.length + 1 });
  const MIN = 60_000;
  let clock = Date.UTC(start, 0, 1) - 9 * HOUR;
  for (let d = 0; d < days; d++) {
    const dayStart = Date.UTC(start, 0, 1 + d) - 9 * HOUR;
    const sessions = Math.floor(rand() * 4);
    for (let s = 0; s < sessions; s++) {
      clock = Math.max(clock + 30 * MIN, dayStart + (8 + Math.floor(rand() * 15)) * HOUR + Math.floor(rand() * 60) * MIN);
      let prev = -1;
      const turns = 6 + Math.floor(rand() * 35);
      for (let t = 0; t < turns; t++) {
        let who = weighted();
        if (who === prev && rand() < 0.85) who = (who + 1 + Math.floor(rand() * (people - 1))) % people;
        prev = who;
        if (rand() < 0.002) push({ ts: clock, sender: null, kind: "system", text: `${memberName(who)}님이 들어왔습니다.` });
        for (let k = burstSize(); k > 0; k--) {
          const r = rand();
          const kind: ChatMessage["kind"] = r < 0.7 ? "text" : r < 0.88 ? "text" : r < 0.94 ? "photo" : r < 0.99 ? "emoticon" : "video";
          const text = kind !== "text" ? "" : r < 0.7 ? pick(BURSTY_TEXTS) : pick(BURSTY_REACTIONS);
          push({ ts: clock, sender: memberName(who), kind, text });
          if (rand() < 0.25) clock += MIN;
        }
        const gap = rand();
        clock += gap < 0.3 ? 0 : gap < 0.7 ? MIN : (2 + Math.floor(rand() * 4)) * MIN;
      }
    }
  }
  return out;
}
