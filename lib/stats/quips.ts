// 숫자 카드의 재치 한 줄(v2.9). 숫자가 든 구간마다 고정 문구를 고른다(AI 비용 없음). 문구는 이 앱이 지은 것이고 표는 quips.test가 고정한다.
// 메시지 수는 표지 폴라로이드 아래, 답장 속도·새벽 대화·가장 수다스러운 시간은 하이라이트 카드 숫자 아래에 보인다

import { NIGHT_END, NIGHT_START } from "@/lib/config";

const MIN = 60_000;

/** "밤 10시~새벽 5시"(NIGHT_START~NIGHT_END) */
export const NIGHT_RANGE = `밤 ${NIGHT_START > 12 ? NIGHT_START - 12 : NIGHT_START}시~새벽 ${NIGHT_END}시`;

/** [이 값 미만(답장은 이하)까지, 문구] 순서대로 */
export const QUIPS = {
  messages: [
    [100, "이제 막 첫 장을 넘긴 사이"],
    [1_000, "수첩 한 권은 채운 분량"],
    [10_000, "단편집 한 권은 나올 분량"],
    [50_000, "장편 연재도 거뜬한 분량"],
    [Infinity, "대하소설 전집 급 기록"],
  ],
  replyMs: [
    [MIN, "거의 실시간"],
    [5 * MIN, "라면 물 끓기 전에 온다"],
    [30 * MIN, "한숨 돌리고 답하는 편"],
    [180 * MIN, "바빠도 꼬박꼬박"],
    [Infinity, "답장은 내일의 나에게"],
  ],
  night: [
    [0.05, "다들 일찍 자는 모범생"],
    [0.2, "가끔 밤이 길어진다"],
    [0.4, "해 지면 살아나는 방"],
    [Infinity, "밤이 본업인 방"],
  ],
} as const satisfies Record<string, readonly (readonly [number, string])[]>;

/** 시각(0~23)마다: [이 시각까지, 이름 앞말, 문구] */
const HOURS: readonly (readonly [number, string, string])[] = [
  [4, "새벽", "새벽 수다 모임"],
  [8, "오전", "해 뜨면 바로 출석"],
  [11, "오전", "오전부터 딴짓 중"],
  [13, "", "점심시간이 곧 수다 시간"],
  [17, "오후", "오후의 나른한 수다"],
  [21, "저녁", "저녁 먹고 모이는 방"],
  [23, "밤", "자기 전 한마디가 길어진다"],
];

const below = (table: readonly (readonly [number, string])[], v: number) => table.find(([upTo]) => v < upTo)![1];
const upTo = (table: readonly (readonly [number, string])[], v: number) => table.find(([max]) => v <= max)![1];

export const messageQuip = (total: number): string => below(QUIPS.messages, total);
/** 답장 중앙값은 구간 끝을 포함한다(1분이면 거의 실시간) */
export const replyQuip = (ms: number | null | undefined): string | null => (typeof ms === "number" && Number.isFinite(ms) ? upTo(QUIPS.replyMs, ms) : null);
export const nightQuip = (ratio: number): string => below(QUIPS.night, ratio);

/** 메시지가 가장 많은 시각(0~23, 동률은 이른 시각). 메시지가 없으면 null */
export function peakHour(hist: readonly number[]): number | null {
  let best = -1;
  for (let h = 0; h < 24; h++) if ((hist[h] ?? 0) > 0 && (best < 0 || hist[h] > hist[best])) best = h;
  return best < 0 ? null : best;
}

const hourRow = (h: number) => HOURS.find(([max]) => h <= max)!;
/** "새벽 2시"·"오전 9시"·"낮 12시"·"오후 3시"·"저녁 9시"·"밤 11시" */
export function hourLabel(h: number): string {
  if (h === 12) return "낮 12시";
  const [, prefix] = hourRow(h);
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${prefix || "오후"} ${twelve}시`;
}
export const peakQuip = (h: number): string => hourRow(h)[2];
