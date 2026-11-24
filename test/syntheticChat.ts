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
