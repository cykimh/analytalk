// 모델에게 보여 줄 통계 요약. stats는 사람 수 × 달 수에, dailyCounts는 날짜 수에 비례해 커져서 프롬프트에는 줄여 넣는다.
// 줄이는 것은 모델이 보는 것뿐이다. 서버의 자리표시자 해석(resolveStat·validateReport)은 전체 stats를 그대로 쓴다.
import { PROMPT_STATS_MAX_CROSSED, PROMPT_STATS_MAX_MONTHS, PROMPT_STATS_MAX_PEOPLE } from "@/lib/config";
import type { ChatStats, MonthStats } from "./compute";

/** dailyCounts를 빼고 사람·달·엇갈린 패턴을 줄인 stats. omitted는 빠진 사람 수와 달 수다 */
export type PromptStats = Omit<ChatStats, "dailyCounts" | "laughChars"> & { omitted: { people: number; months: number } };

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 프롬프트용 stats(새 객체, 입력과 공유하는 값이 없다).
 * - 사람: byPerson 메시지 수 상위 PROMPT_STATS_MAX_PEOPLE명(동률은 이름 오름차순). 사람이 키인 맵은 모두 이 사람들만, 이 순서로 남긴다.
 *   addressTerms는 바깥 키가 부른 사람이고 안쪽 키는 호칭이라 바깥 키만 거른다
 * - 달: monthly의 가장 최근 PROMPT_STATS_MAX_MONTHS개
 * - crossed: 남은 사람·남은 달의 것 중 가장 최근 PROMPT_STATS_MAX_CROSSED개(달 순서)
 * - dailyCounts는 뺀다. 총계·히스토그램·nightRatio·longestStreakDays·busiestDay는 그대로다
 * - laughChars(v2.8, ㅋ 글자 수)는 화면의 하이라이트 카드만 쓰므로 싣지 않는다(모델이 보는 <stats>는 v2.7과 같다)
 * ChatStats에 사람이 키인 맵을 더하면 여기에도 더한다
 */
export function statsForPrompt(stats: ChatStats): PromptStats {
  const people = Object.entries(stats.byPerson)
    .sort(([a, x], [b, y]) => y - x || byName(a, b))
    .slice(0, PROMPT_STATS_MAX_PEOPLE)
    .map(([name]) => name);
  const keep = new Set(people);
  /** rec에서 남은 사람만 메시지 많은 순서로 */
  const only = <T>(rec: Record<string, T>): Record<string, T> =>
    Object.fromEntries(people.filter((name) => Object.hasOwn(rec, name)).map((name) => [name, rec[name]]));

  const allMonths = Object.keys(stats.monthly).sort(byName);
  const months = new Set(allMonths.slice(-PROMPT_STATS_MAX_MONTHS));
  const monthly = Object.fromEntries(
    allMonths
      .filter((key) => months.has(key))
      .map((key): [string, MonthStats] => {
        const m = stats.monthly[key];
        return [
          key,
          {
            count: only(m.count),
            replyMedianMs: only(m.replyMedianMs),
            replyP75Ms: only(m.replyP75Ms),
            questionRate: only(m.questionRate),
            avgLen: only(m.avgLen),
          },
        ];
      }),
  );

  const crossed = stats.crossed
    .filter((c) => keep.has(c.person) && months.has(c.month))
    .sort((a, b) => byName(a.month, b.month))
    .slice(-PROMPT_STATS_MAX_CROSSED);

  const view: PromptStats = {
    total: stats.total,
    byPerson: only(stats.byPerson),
    share: only(stats.share),
    initiations: only(stats.initiations),
    closings: only(stats.closings),
    replyReceivedRate: only(stats.replyReceivedRate),
    replyMedianMs: only(stats.replyMedianMs),
    replyP75Ms: only(stats.replyP75Ms),
    monthly,
    hourHistogram: stats.hourHistogram,
    weekdayHistogram: stats.weekdayHistogram,
    nightRatio: stats.nightRatio,
    longestStreakDays: stats.longestStreakDays,
    busiestDay: stats.busiestDay,
    laughLength: only(stats.laughLength),
    questionRate: only(stats.questionRate),
    media: only(stats.media),
    addressTerms: only(stats.addressTerms),
    crossed,
    omitted: { people: Object.keys(stats.byPerson).length - people.length, months: allMonths.length - months.size },
  };
  // 배열·안쪽 객체까지 입력과 떼어 놓는다(크기가 위 상한으로 묶여 있어 복사는 싸다)
  return structuredClone(view);
}
