import { describe, expect, it } from "vitest";
import { PROMPT_STATS_MAX_CROSSED, PROMPT_STATS_MAX_MONTHS, PROMPT_STATS_MAX_PEOPLE } from "@/lib/config";
import type { ChatMessage } from "@/lib/parse/parse";
import { syntheticGroupChat } from "@/test/syntheticChat";
import { type ChatStats, computeStats } from "./compute";
import { type PromptStats, statsForPrompt } from "./view";

/** 사람 이름이 키인 맵 전부(addressTerms는 바깥 키가 부른 사람, 안쪽 키는 호칭이다) */
const personMaps = (s: PromptStats | ChatStats) => ({
  byPerson: s.byPerson,
  share: s.share,
  initiations: s.initiations,
  closings: s.closings,
  replyReceivedRate: s.replyReceivedRate,
  replyMedianMs: s.replyMedianMs,
  replyP75Ms: s.replyP75Ms,
  laughLength: s.laughLength,
  questionRate: s.questionRate,
  media: s.media,
  addressTerms: s.addressTerms,
  ...Object.fromEntries(
    Object.entries(s.monthly).flatMap(([month, m]) => Object.entries(m).map(([metric, rec]) => [`monthly.${month}.${metric}`, rec])),
  ),
});

describe("statsForPrompt: 40명 × 60개월", () => {
  const full = computeStats(syntheticGroupChat(40, 60));
  const view = statsForPrompt(full);
  const ranked = Object.entries(full.byPerson)
    .sort(([, x], [, y]) => y - x)
    .map(([name]) => name);
  const top = ranked.slice(0, PROMPT_STATS_MAX_PEOPLE);
  const keep = new Set(top);
  const recent = Object.keys(full.monthly).sort().slice(-PROMPT_STATS_MAX_MONTHS);

  it("가짜 대화가 전제를 지킨다: 40명, 60개월, 사람마다 메시지 수가 다르다", () => {
    expect(ranked).toHaveLength(40);
    expect(new Set(Object.values(full.byPerson)).size).toBe(40);
    expect(Object.keys(full.monthly)).toHaveLength(60);
    for (const m of Object.values(full.monthly)) expect(Object.keys(m.count)).toHaveLength(40);
  });

  it("사람은 메시지가 많은 12명만, 많은 순서로 남는다", () => {
    expect(Object.keys(view.byPerson)).toEqual(top);
    for (const [where, rec] of Object.entries(personMaps(view))) {
      expect([where, Object.keys(rec).every((name) => keep.has(name))]).toEqual([where, true]);
    }
    expect(Object.keys(view.share)).toEqual(top);
    expect(view.byPerson[top[0]]).toBe(full.byPerson[top[0]]);
  });

  it("monthly는 최근 24개월, 그 안의 맵도 남은 사람만", () => {
    expect(Object.keys(view.monthly)).toEqual(recent);
    expect(recent).toHaveLength(24);
    expect(recent[0]).toBe("2024-01");
    for (const month of recent) {
      for (const metric of ["count", "replyMedianMs", "replyP75Ms", "questionRate", "avgLen"] as const) {
        expect(Object.keys(view.monthly[month][metric])).toEqual(top);
      }
      expect(view.monthly[month].avgLen[top[3]]).toBe(full.monthly[month].avgLen[top[3]]);
    }
  });

  it("addressTerms는 부른 사람(바깥 키)만 거르고 호칭(안쪽 키)은 그대로 둔다", () => {
    expect(Object.keys(view.addressTerms).length).toBeGreaterThan(0);
    for (const [who, terms] of Object.entries(view.addressTerms)) {
      expect(keep.has(who)).toBe(true);
      expect(terms).toEqual(full.addressTerms[who]);
    }
  });

  it("dailyCounts는 빼고 히스토그램·총계·busiestDay·longestStreakDays·nightRatio는 그대로", () => {
    expect(view).not.toHaveProperty("dailyCounts");
    expect(view.total).toBe(full.total);
    expect(view.hourHistogram).toEqual(full.hourHistogram);
    expect(view.weekdayHistogram).toEqual(full.weekdayHistogram);
    expect(view.busiestDay).toEqual(full.busiestDay);
    expect(view.longestStreakDays).toBe(full.longestStreakDays);
    expect(view.nightRatio).toBe(full.nightRatio);
  });

  it("crossed는 남은 사람·남은 달의 것 중 최근 20개(달 순서 그대로)", () => {
    const months = new Set(recent);
    const eligible = full.crossed.filter((c) => keep.has(c.person) && months.has(c.month));
    expect(eligible.length).toBeGreaterThan(PROMPT_STATS_MAX_CROSSED);
    expect(view.crossed).toEqual(eligible.slice(-PROMPT_STATS_MAX_CROSSED));
  });

  it("omitted는 빠진 사람 28명, 빠진 달 36개", () => {
    expect(view.omitted).toEqual({ people: 28, months: 36 });
  });

  it("JSON은 36,000자 이하", () => {
    expect(JSON.stringify(view).length).toBeLessThanOrEqual(36_000);
  });
});

describe("statsForPrompt: 작은 대화와 동률", () => {
  it("3명·3개월이면 dailyCounts·화면 전용 통계(v2.8·v2.9) 말고는 원래 stats와 같고 omitted는 0", () => {
    const full = computeStats(syntheticGroupChat(3, 3));
    expect(Object.keys(full.byPerson)).toHaveLength(3);
    expect(Object.keys(full.monthly)).toHaveLength(3);
    const { dailyCounts, laughChars, nightByPerson, replyMedianAll, style, habits, unanswered, topWords, ...rest } = full;
    expect(Object.keys(dailyCounts).length).toBeGreaterThan(0);
    for (const screenOnly of [laughChars, nightByPerson, style, habits, unanswered, topWords]) expect(Object.keys(screenOnly ?? {})).toHaveLength(3);
    expect(replyMedianAll).not.toBeUndefined();
    expect(statsForPrompt(full)).toStrictEqual({ ...rest, omitted: { people: 0, months: 0 } });
  });

  it("메시지 수가 같으면 이름 오름차순으로 자른다", () => {
    // 14명: 맨 앞 사람만 3개, 나머지 13명은 2개씩. 이름은 섞인 순서로 처음 나온다
    const names = ["P09", "P13", "P01", "P12", "P05", "P02", "P11", "P07", "P03", "P10", "P06", "P04", "P08", "P00"];
    const messages: ChatMessage[] = [];
    names.forEach((sender, i) => {
      for (let k = 0; k < (i === 0 ? 3 : 2); k++) {
        const id = messages.length;
        messages.push({ id, ts: Date.UTC(2026, 9, 1) + id * 60_000, sender, kind: "text", text: "안녕", line: id + 1 });
      }
    });
    const view = statsForPrompt(computeStats(messages));
    expect(Object.keys(view.byPerson)).toEqual(["P09", "P00", "P01", "P02", "P03", "P04", "P05", "P06", "P07", "P08", "P10", "P11"]);
    expect(view.omitted).toEqual({ people: 2, months: 0 });
  });

  it("입력 stats를 바꾸지 않고, 결과를 고쳐도 입력에 번지지 않는다", () => {
    const full = computeStats(syntheticGroupChat(20, 15));
    const before = structuredClone(full);
    const view = statsForPrompt(full);
    expect(full).toStrictEqual(before);

    const someone = Object.keys(view.laughLength)[0];
    view.laughLength[someone][1] = -1;
    view.hourHistogram[0] = -1;
    view.media[someone].photo = -1;
    if (view.busiestDay) view.busiestDay.count = -1;
    if (view.crossed[0]) view.crossed[0].upPct = -1;
    const month = Object.keys(view.monthly)[0];
    view.monthly[month].count[someone] = -1;
    expect(full).toStrictEqual(before);
  });
});
