import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/lib/parse/parse";
import { MAX_PAYLOAD_BYTES, PROMPT_RESERVE_TOKENS, SAMPLE_CHUNKS_PER_MONTH } from "@/lib/config";
import { computeStats } from "@/lib/stats/compute";
import { statsForPrompt } from "@/lib/stats/view";
import { syntheticBurstyChat, syntheticGroupChat } from "@/test/syntheticChat";
import {
  BUNDLE_MAX_CHARS,
  BUNDLE_MAX_PARTS,
  BUNDLE_SEP,
  buildPayload,
  buildPayloadForBudget,
  foldedCount,
  isReaction,
  legendText,
  memberCodes,
  payloadIndex,
  payloadTokens,
  REACTION_MAX_CHARS,
  readBlock,
} from "./build";
import { maskPII } from "./mask";
import { applyDisplayNames, type NameMap } from "./names";
import { validatePayload } from "./validate";

const MIN = 60_000;
/** KST 벽시계 → UTC epoch ms */
const kst = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) - 9 * 3_600_000;
/** 기대값용 ISO(+09:00). 구현과 다른 방법으로 만든다 */
const iso = (ts: number) => `${new Date(ts + 9 * 3_600_000).toISOString().slice(0, 19)}+09:00`;

type Raw = [sender: string | null, ts: number, text: string, kind?: ChatMessage["kind"]];
const chat = (rows: Raw[]): ChatMessage[] =>
  rows.map(([sender, ts, text, kind], id) => ({
    id,
    ts,
    sender,
    kind: kind ?? (sender === null ? "system" : "text"),
    text,
    line: id + 1,
  }));

const MAP: NameMap = { 김민지: "P1", 민지폰: "P1", 이철수: "P2", 박영희: "P3" };
/** 분석에서 뺀 멤버의 이름과 고유한 문장 */
const OUT = "박영희";
const OUT_LINE = "영희만의고유문장";

/** 3일치 대화(하루 100개 + 뺀 멤버의 메시지)를 이름 정리까지 거친다. 본문은 바뀌지 않는다 */
function named(): ChatMessage[] {
  const rows: Raw[] = [[null, kst(2026, 10, 1, 8), "박영희님이 들어왔습니다."]];
  for (let day = 1; day <= 3; day++) {
    for (let i = 0; i < 100; i++) {
      const sender = ["김민지", "이철수", "민지폰"][i % 3];
      const text = ["김민지야 뭐해", "철수랑 영화 보자", "영희 나갔대", "민지폰으로 보냄", "ㅋㅋ 내일 봐"][i % 5];
      rows.push([sender, kst(2026, 10, day, 9) + i * MIN, text]);
    }
    rows.push([OUT, kst(2026, 10, day, 12), OUT_LINE]);
  }
  const r = applyDisplayNames(chat(rows), { map: MAP, merged: [["김민지", "민지폰"]], excluded: [OUT] });
  if (!r.ok) throw new Error(r.reason);
  return r.messages;
}

const build = (messages: ChatMessage[], tokenBudget = 1_000_000, tokensPerChar = 1) =>
  buildPayload({ messages, tone: "warm", concept: "couple", kind: "pair", tokenBudget, tokensPerChar });
/** 덩어리 하나의 추정 토큰(tokensPerChar 1). 구현과 같은 정의: 줄마다 글자 수 + 1 */
const tokens = (block: string) => lines(block).reduce((sum, l) => sum + l.length + 1, 0);

const lines = (block: string) => (block === "" ? [] : block.split("\n"));
/** 블록의 메시지 줄 msg_id들(날짜 헤더 제외) */
const ids = (block: string) =>
  lines(block).flatMap((l) => {
    const m = /^m(\d+)\|/.exec(l);
    return m ? [Number(m[1])] : [];
  });

describe("buildPayload", () => {
  it("예산 1,000: transcript는 마지막 메시지로 끝나고, cutoffAt은 그 첫 메시지 시각", () => {
    const messages = named();
    const p = build(messages, 1000);
    const sent = ids(p.transcript);
    const last = messages[messages.length - 1];

    // 예산은 anchors + transcript 몫이고, 남김없이 거의 다 쓴다
    expect(tokens(p.anchors) + tokens(p.transcript)).toBeLessThanOrEqual(1000);
    expect(tokens(p.anchors) + tokens(p.transcript)).toBeGreaterThan(900);
    expect(payloadTokens(p, 1).text).toBe(tokens(p.anchors) + tokens(p.transcript));
    expect(lines(p.transcript).at(-1)).toMatch(new RegExp(`^m${last.id}\\|`));
    expect(p.msgSent).toBe(sent.length);
    expect(p.msgSent).toBeLessThan(p.msgTotal);
    expect(p.msgTotal).toBe(300);
    expect(p.cutoffAt).toBe(iso(messages.find((m) => m.id === sent[0])!.ts));
    expect(p.period).toEqual({ start: "2026-10-01", end: "2026-10-03" });
  });

  it("뺀 멤버의 이름(발신자로서)·본문·stats 키가 JSON에 0건", () => {
    const messages = named();
    expect(messages.some((m) => m.sender === OUT || m.text === OUT_LINE)).toBe(false);
    const p = build(messages, 1_000_000);
    const json = JSON.stringify(p);
    expect(json.includes(OUT_LINE)).toBe(false);
    expect(p.members).toEqual(["P1", "P2"]);
    expect(Object.keys(p.stats.byPerson)).toEqual(["P1", "P2"]);
    expect(json.includes(`"${OUT}"`)).toBe(false);
    expect(json.includes(`${OUT}|`)).toBe(false);
    expect(p.msgTotal).toBe(300);
  });

  it("별칭 둘을 합치면 stats.byPerson 키가 1개", () => {
    const raw = chat([
      ["김민지", kst(2026, 10, 1, 9), "폰에서"],
      ["민지폰", kst(2026, 10, 1, 9, 1), "PC에서"],
    ]);
    const r = applyDisplayNames(raw, { map: { 김민지: "P1", 민지폰: "P1" }, merged: [["김민지", "민지폰"]] });
    if (!r.ok) throw new Error(r.reason);
    const p = build(r.messages);
    expect(Object.keys(p.stats.byPerson)).toEqual(["P1"]);
    expect(p.members).toEqual(["P1"]);
  });

  it("줄 형식, 날짜 헤더, 본문 처리(미디어·꺾쇠·줄바꿈·개인정보, 민감 주제는 그대로)", () => {
    const messages = chat([
      [null, kst(2026, 10, 1, 8), "P2님이 들어왔습니다."],
      ["P1", kst(2026, 10, 1, 9, 5), "사진", "photo"],
      ["P2", kst(2026, 10, 1, 23, 59), "a<b>c"],
      ["P1", kst(2026, 10, 2, 0, 1), "첫 줄\n둘째 줄"],
      ["P2", kst(2026, 10, 2, 0, 2), "임신 테스트기 샀어"],
      ["P1", kst(2026, 10, 2, 0, 3), "내 번호 010-1234-5678"],
    ]);
    const p = build(messages);
    expect(lines(p.transcript)).toEqual([
      "# 2026-10-01",
      "m1|09:05|A|[사진]",
      "m2|23:59|B|a＜b＞c",
      "# 2026-10-02",
      "m3|00:01|A|첫 줄 ⏎ 둘째 줄",
      "m4|00:02|B|임신 테스트기 샀어",
      "m5|00:03|A|내 번호 [가림:전화]",
    ]);
    expect(p.anchors).toBe("");
    expect(p.maskCounts).toEqual({ phone: 1, email: 0, account: 0, rrn: 0, url: 0 });
    expect(p).toMatchObject({ v: 2, tone: "warm", concept: "couple", kind: "pair", members: ["P1", "P2"], msgTotal: 5, msgSent: 5 });
    expect("me" in p).toBe(false);
  });

  it("maskCounts 키는 phone·email·account·rrn·url뿐이고, 링크는 사이트 이름만 남는다", () => {
    const p = build(
      chat([
        ["P1", kst(2026, 10, 1, 9), "이거 봐 https://www.youtube.com/watch?v=abc"],
        ["P2", kst(2026, 10, 1, 9, 1), "ㅇㅋ"],
      ]),
    );
    expect(Object.keys(p.maskCounts).sort()).toEqual(["account", "email", "phone", "rrn", "url"]);
    expect(p.maskCounts.url).toBe(1);
    expect(lines(p.transcript)[1]).toBe("m0|09:00|A|이거 봐 [링크:youtube.com]");
    expect(p.transcript).not.toContain("watch");
  });

  it("마지막 줄을 [링크:… 가운데서 자르는 예산에서도 validatePayload를 통과한다", () => {
    const messages = chat([
      ["P2", kst(2026, 10, 1, 8), "먼저"],
      ["P1", kst(2026, 10, 1, 9), "봐 https://youtube.com/watch?v=abcdef 이거 010-1234-5678"],
    ]);
    let cutInsideMark = 0;
    for (let budget = 40; budget < 140; budget++) {
      let p;
      try {
        p = build(messages, budget);
      } catch {
        continue; // 헤더와 줄 머리도 안 들어가는 예산
      }
      const last = lines(p.transcript).at(-1)!;
      if (/\[링크[^\]]*…$/.test(last)) cutInsideMark++;
      expect([budget, validatePayload(p).ok]).toEqual([budget, true]);
    }
    expect(cutInsideMark).toBeGreaterThan(0);
  });

  it("대화 전체가 예산에 들어가면 모두 transcript이고 anchors는 비어 있다", () => {
    const messages = named();
    const all = build(messages);
    expect(all.anchors).toBe("");
    expect(all.msgSent).toBe(all.msgTotal);
    // 딱 맞는 예산이어도 anchors 몫을 떼지 않는다
    const exact = build(messages, payloadTokens(all, 1).text);
    expect(exact.transcript).toBe(all.transcript);
    expect(exact.anchors).toBe("");
  });

  it("시스템 메시지뿐이면 던진다", () => {
    expect(() => build(chat([[null, kst(2026, 10, 1, 8), "P1님이 들어왔습니다."]]))).toThrow("보낼 메시지가 없다");
  });
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BUSIEST = "2024-07-14";
/** 3년 치(2023-01-01~2025-12-31) 매일 아침 8개 + 가장 활발한 날 하루 600개. 날마다 09:00에 대화를 시작한다(전날과 6시간 넘게 쉼) */
function threeYears(): ChatMessage[] {
  const rows: Raw[] = [];
  for (let t = kst(2023, 1, 1); t < kst(2026, 1, 1); t += DAY) {
    const n = new Date(t + 9 * HOUR).toISOString().slice(0, 10) === BUSIEST ? 600 : 8;
    for (let i = 0; i < n; i++) rows.push([i % 2 ? "P1" : "P2", t + 9 * HOUR + i * MIN, `${i}번째 이야기를 이어서 해 보자`]);
  }
  return chat(rows);
}
/** transcript 메시지 줄들의 msg_id·KST 날짜·시각 */
const sentLines = (block: string) =>
  readBlock(block).flatMap((l) => (l.type === "message" ? [{ id: l.id, day: l.header!, time: l.time }] : []));
/** 이어진 msg_id 덩어리들(시간순) */
function runsOf(idList: number[]): number[][] {
  const runs: number[][] = [];
  for (const id of idList) {
    const last = runs.at(-1);
    if (last && last.at(-1)! + 1 === id) last.push(id);
    else runs.push([id]);
  }
  return runs;
}

describe("buildPayload: 대화가 예산보다 길면 전체 기간에서 고르게 고른다", () => {
  const messages = threeYears();
  const months = [2023, 2024, 2025].flatMap((y) => Array.from({ length: 12 }, (_, m) => `${y}-${String(m + 1).padStart(2, "0")}`));

  it("3년 치, 빠듯한 예산 20,000: 해마다·달마다·가장 활발한 날의 메시지가 있고 마지막 메시지로 끝난다", () => {
    const p = build(messages, 20_000);
    const sent = sentLines(p.transcript);
    expect(p.msgSent).toBeLessThan(p.msgTotal / 10);
    expect(p.anchors).toBe("");
    expect(new Set(sent.map((l) => l.day.slice(0, 4)))).toEqual(new Set(["2023", "2024", "2025"]));
    expect([...new Set(sent.map((l) => l.day.slice(0, 7)))]).toEqual(months);
    expect(sent.some((l) => l.day === BUSIEST)).toBe(true);
    expect(sent.at(-1)!.id).toBe(messages.length - 1);
    // 시간순(msg_id가 커지기만)이고 msg_id로 되찾을 수 있다
    expect(sent.map((l) => l.id)).toEqual([...sent.map((l) => l.id)].sort((a, b) => a - b));
    expect(payloadIndex(p).size).toBe(p.msgSent);
    expect(validatePayload(p).ok).toBe(true);
    expect(p.cutoffAt).toBe(iso(messages[sent[0].id].ts));
  });

  it("달 몫은 달마다 연속 덩어리 몇 개이고, 덩어리는 대화가 시작하는 곳(09:00)에서 시작한다", () => {
    for (const budget of [20_000, 200_000]) {
      const p = build(messages, budget);
      const sent = sentLines(p.transcript);
      const byId = new Map(sent.map((l) => [l.id, l]));
      const runs = runsOf(sent.map((l) => l.id));
      const tail = runs.at(-1)!;
      // 최근 구간 앞의 덩어리들(가장 활발한 날이 든 달은 그날 몫과 달 몫이 섞여서 뺀다)
      const middle = runs.slice(0, -1).filter((r) => !r.some((id) => byId.get(id)!.day.startsWith(BUSIEST.slice(0, 7))));
      expect(middle.length).toBeGreaterThan(30);
      for (const r of middle) {
        expect([budget, byId.get(r[0])!.time]).toEqual([budget, "09:00"]);
        expect(r.length).toBeGreaterThan(1);
      }
      const perMonth = new Map<string, number>();
      for (const r of middle) {
        const m = byId.get(r[0])!.day.slice(0, 7);
        perMonth.set(m, (perMonth.get(m) ?? 0) + 1);
      }
      for (const [m, n] of perMonth) expect([budget, m, n <= SAMPLE_CHUNKS_PER_MONTH]).toEqual([budget, m, true]);
      expect(tail.length).toBeGreaterThan(1);
    }
  });

  it("최근 구간을 조금 더: 마지막 달에서 고른 메시지가 보통 달의 두 배 넘게 많다", () => {
    const p = build(messages, 60_000);
    const count = new Map<string, number>();
    for (const l of sentLines(p.transcript)) count.set(l.day.slice(0, 7), (count.get(l.day.slice(0, 7)) ?? 0) + 1);
    const sorted = [...count.values()].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    expect(count.get("2025-12")!).toBeGreaterThan(median * 2);
  });

  it("예산을 넘지 않고 거의 다 쓴다(여러 예산·tokensPerChar), validatePayload를 통과한다", () => {
    for (const tokensPerChar of [1, 0.8, 0.37]) {
      for (const budget of [400, 1000, 3000, 7777, 20_000, 123_456]) {
        const p = build(messages, budget, tokensPerChar);
        const { text } = payloadTokens(p, tokensPerChar);
        expect([tokensPerChar, budget, text <= budget]).toEqual([tokensPerChar, budget, true]);
        expect([tokensPerChar, budget, text > budget * 0.9]).toEqual([tokensPerChar, budget, true]);
        expect([tokensPerChar, budget, validatePayload(p).ok]).toEqual([tokensPerChar, budget, true]);
      }
    }
  });

  it("활발한 단톡방: 상위 3일이 모두 조금씩 들어 있고, 예산을 0.95배로 줄이면(413 재요청) 보내는 몫도 줄어든다", () => {
    // 평소 60일 × 20개 + 상위 3일 × 1,500개. 상위 날짜만 해도 예산의 몇 배다
    const rows: Raw[] = [];
    const busy = new Set([10, 30, 50]);
    for (let day = 0; day < 60; day++) {
      const n = busy.has(day) ? 1500 : 20;
      for (let i = 0; i < n; i++) {
        rows.push([`P${(i % 4) + 1}`, kst(2026, 1, 1, 9) + day * DAY + i * 20_000, `오늘 ${day}일 ${i}번째 이야기`]);
      }
    }
    const group = chat(rows);
    const dayOf = (id: number) => new Date(group[id].ts + 9 * HOUR).toISOString().slice(0, 10);
    const busyDays = [...busy].map((d) => dayOf(rows.findIndex((r) => r[1] >= kst(2026, 1, 1, 9) + d * DAY)));

    let budget = 50_000;
    let prevText = Infinity;
    for (let round = 0; round < 3; round++) {
      const p = buildPayload({ messages: group, tone: "warm", concept: "group", kind: "group", tokenBudget: budget, tokensPerChar: 1 });
      const { text, total } = payloadTokens(p, 1);
      expect(text).toBeLessThanOrEqual(budget);
      expect(text).toBeGreaterThan(budget * 0.95);
      expect(total).toBe(text + JSON.stringify(statsForPrompt(p.stats)).length + legendText(p.members).length + 1);
      expect(text).toBeLessThan(prevText);
      const sent = ids(p.transcript);
      for (const d of busyDays) expect(sent.some((id) => dayOf(id) === d)).toBe(true);
      expect(new Set(sent.map((id) => dayOf(id).slice(0, 7)))).toEqual(new Set(["2026-01", "2026-02", "2026-03"]));
      expect(sent.at(-1)).toBe(group.length - 1);
      prevText = text;
      budget = Math.floor(budget * 0.95);
    }
  });

  it("달마다 첫 메시지가 덩어리 몫보다 길어도(긴 공지) 그 달이 비지 않는다: 들어가는 다음 줄부터 고른다", () => {
    // 60개월, 달마다 1일 09:00에 4,000자 공지 한 줄 + 짧은 말 300개(같은 대화). 달 몫이 공지 한 줄보다 작은 예산
    const rows: Raw[] = [];
    const notice = "공지 사항을 길게 붙여 넣었다 ".repeat(300).slice(0, 4000);
    const monthKeys: string[] = [];
    for (let k = 0; k < 60; k++) {
      const y = 2021 + Math.floor(k / 12);
      const mo = (k % 12) + 1;
      monthKeys.push(`${y}-${String(mo).padStart(2, "0")}`);
      rows.push(["P1", kst(y, mo, 1, 9), notice]);
      for (let i = 0; i < 300; i++) rows.push([i % 2 ? "P1" : "P2", kst(y, mo, 1, 9, 1) + i * 20_000, `짧은 대답 ${i}`]);
    }
    const long = chat(rows);
    for (const budget of [150_000, 60_000]) {
      const p = build(long, budget);
      const sent = sentLines(p.transcript);
      expect([budget, payloadTokens(p, 1).text <= budget]).toEqual([budget, true]);
      expect([budget, [...new Set(sent.map((l) => l.day.slice(0, 7)))]]).toEqual([budget, monthKeys]);
      expect(validatePayload(p).ok).toBe(true);
      expect(sent.at(-1)!.id).toBe(long.length - 1);
    }
  });

  it("작은 대화는 예산이 넉넉하면 전부 보낸다(3년 치도)", () => {
    const all = build(messages, 1_000_000);
    expect(all.msgSent).toBe(all.msgTotal);
    expect(all.anchors).toBe("");
    expect(ids(all.transcript)).toEqual(messages.map((m) => m.id));
  });
});

describe("buildPayload: 마지막 메시지 한 줄이 예산보다 길 때", () => {
  const MSG = /^m(\d+)\|\d{2}:\d{2}\|[A-Z]{1,3}\|(.*)$/;
  /** transcript의 메시지 줄 본문들 */
  const bodies = (block: string) => lines(block).flatMap((l) => MSG.exec(l)?.slice(2) ?? []);
  const group = (messages: ChatMessage[], tokenBudget: number) =>
    buildPayload({ messages, tone: "warm", concept: "group", kind: "group", tokenBudget, tokensPerChar: 1 });

  it("5000자 메시지 1건, 예산 1,000: 본문을 잘라 …로 끝내고 transcript에 1건 넣는다", () => {
    const text = "오늘 있었던 일을 길게 적어 볼게 ".repeat(300).slice(0, 5000);
    const p = group(chat([["P2", kst(2026, 10, 1, 8), "먼저 한마디"], ["P1", kst(2026, 10, 1, 9), text]]), 1000);
    expect(p.msgSent).toBe(1);
    expect(validatePayload(p).ok).toBe(true);
    expect(lines(p.transcript).at(-1)).toMatch(/…$/);
    expect(text.startsWith(bodies(p.transcript)[0].slice(0, -1))).toBe(true);
    expect(payloadTokens(p, 1).text).toBeLessThanOrEqual(1000);
    expect(payloadTokens(p, 1).text).toBeGreaterThan(950);
  });

  it("앞에 메시지가 있어도 가장 최근 메시지를 잘라 넣는다", () => {
    const rows: Raw[] = Array.from({ length: 50 }, (_, i) => [i % 2 ? "P2" : "P1", kst(2026, 10, 1, 9, i), "짧은 말"]);
    rows.push(["P2", kst(2026, 10, 1, 10), "가".repeat(5000)]);
    const p = group(chat(rows), 1000);
    expect(ids(p.transcript)).toEqual([50]);
    expect(validatePayload(p).ok).toBe(true);
    expect(payloadTokens(p, 1).text).toBeLessThanOrEqual(1000);
  });

  it("자른 끝이 가릴 모양(숫자 10~16자리, www., ://)이 되지 않게 그 꼬리를 뗀다", () => {
    // 17자리 넘는 숫자, 뒤가 띄어진 www.·https:// 는 원문에서는 가리지 않는다. 자른 위치를 조금씩 옮겨 본다
    const tails = ["1".repeat(40), "12-34-56-78-90-12-34-56", " www. 다음 말", " https:// 다음 말"];
    for (const tail of tails) {
      for (let k = 0; k < 30; k++) {
        const p = group(
          chat([
            ["P2", kst(2026, 10, 1, 8), "먼저 한마디"],
            ["P1", kst(2026, 10, 1, 9), "가".repeat(940 + k) + tail + "나".repeat(200)],
          ]),
          1000,
        );
        const r = validatePayload(p);
        expect([tail, k, r.ok ? "ok" : r.error]).toEqual([tail, k, "ok"]);
        expect(bodies(p.transcript).at(-1)).toMatch(/…$/);
      }
    }
  });

  it("잘라도 날짜 헤더와 줄 머리조차 안 들어가는 예산이면 던진다", () => {
    expect(() => group(chat([["P1", kst(2026, 10, 1, 9), "가".repeat(100)]]), 20)).toThrow();
  });
});

describe("payloadTokens", () => {
  it("total = text + 모델에게 보이는 stats(statsForPrompt) JSON + 범례 글자 수 × tokensPerChar", () => {
    const messages = syntheticGroupChat(20, 18);
    const p = buildPayload({ messages, tone: "warm", concept: "group", kind: "group", tokenBudget: 5000, tokensPerChar: 1 });
    const view = JSON.stringify(statsForPrompt(p.stats)).length;
    const text = tokens(p.anchors) + tokens(p.transcript);
    const legend = legendText(p.members).length + 1;
    expect(view).toBeLessThan(JSON.stringify(p.stats).length);
    expect(payloadTokens(p, 1)).toEqual({ text, total: text + view + legend });
    expect(payloadTokens(p, 0.5).total).toBe((text + view + legend) * 0.5);
  });
});

describe("buildPayloadForBudget", () => {
  const messages = syntheticGroupChat(40, 60);
  const statsChars = JSON.stringify(statsForPrompt(computeStats(messages))).length;
  const legendChars = legendText([...new Set(messages.flatMap((m) => (m.sender ? [m.sender] : [])))]).length + 1;
  const forBudget = (inputBudget: number, tokensPerChar = 1) =>
    buildPayloadForBudget({ messages, tone: "warm", concept: "group", kind: "group", inputBudget, tokensPerChar });

  it("40명 × 60개월, 입력 예산 128,000: 통계 요약·프롬프트 몫까지 예산 안이고 transcript가 있다", () => {
    const p = forBudget(128_000);
    const { text, total } = payloadTokens(p, 1);
    expect(total + PROMPT_RESERVE_TOKENS).toBeLessThanOrEqual(128_000);
    expect(total + PROMPT_RESERVE_TOKENS).toBeGreaterThan(128_000 * 0.97);
    expect(text).toBeLessThanOrEqual(128_000 - PROMPT_RESERVE_TOKENS - statsChars - legendChars);
    expect(p.msgSent).toBeGreaterThan(0);
    expect(validatePayload(p).ok).toBe(true);
    // 서버의 자리표시자 해석용으로 페이로드에는 전체 stats가 그대로 있다
    expect(p.stats).toStrictEqual(computeStats(messages));
    expect(Object.keys(p.stats.byPerson)).toHaveLength(40);
  });

  it("tokensPerChar가 1이 아니어도 예산 안이다", () => {
    const p = forBudget(128_000, 0.8);
    expect(payloadTokens(p, 0.8).total + PROMPT_RESERVE_TOKENS).toBeLessThanOrEqual(128_000);
    expect(payloadTokens(p, 0.8).total + PROMPT_RESERVE_TOKENS).toBeGreaterThan(128_000 * 0.97);
  });

  it("anchors+transcript 몫이 1,000 미만이면 던진다", () => {
    const edge = PROMPT_RESERVE_TOKENS + statsChars + legendChars + 1000;
    expect(payloadTokens(forBudget(edge), 1).text).toBeLessThanOrEqual(1000);
    expect(() => forBudget(edge - 1)).toThrow();
  });

  it("시스템 메시지뿐이면 buildPayload와 같이 던진다", () => {
    const only = chat([[null, kst(2026, 10, 1, 8), "P1님이 들어왔습니다."]]);
    expect(() =>
      buildPayloadForBudget({ messages: only, tone: "warm", concept: "group", kind: "group", inputBudget: 128_000, tokensPerChar: 1 }),
    ).toThrow("보낼 메시지가 없다");
  });
});

describe("payloadIndex", () => {
  it("at은 날짜 헤더의 연도를 이어받은 ISO +09:00, text는 보낸 본문", () => {
    const messages = chat([
      ["P1", kst(2025, 12, 31, 23, 59), "올해 끝"],
      ["P2", kst(2026, 1, 1, 0, 1), "새해 복 a<b>"],
    ]);
    const idx = payloadIndex(build(messages));
    expect([...idx.keys()]).toEqual(["m0", "m1"]);
    expect(idx.get("m0")).toEqual({ sender: "P1", at: "2025-12-31T23:59:00+09:00", text: "올해 끝" });
    expect(idx.get("m1")).toEqual({ sender: "P2", at: "2026-01-01T00:01:00+09:00", text: "새해 복 a＜b＞" });
  });

  it("고른 메시지를 모두 담는다", () => {
    const p = build(named(), 5000);
    const idx = payloadIndex(p);
    expect(idx.size).toBe(ids(p.anchors).length + p.msgSent);
    expect(idx.has("m1")).toBe(true);
  });
});

describe("memberCodes·legendText", () => {
  it("A…Z 다음은 AA(엑셀 열 방식)", () => {
    const codes = memberCodes(Array.from({ length: 27 }, (_, i) => `P${i}`));
    expect(codes[0]).toBe("A");
    expect(codes[25]).toBe("Z");
    expect(codes[26]).toBe("AA");
  });

  it("어떤 멤버의 표시 이름과 같은 기호는 대소문자 무시하고 건너뛴다", () => {
    expect(memberCodes(["민지", "B", "철수"])).toEqual(["A", "C", "D"]);
    expect(memberCodes(["민지", "b", "철수"])).toEqual(["A", "C", "D"]);
  });

  it("범례는 한 줄에 기호=표시 이름", () => {
    expect(legendText(["민지", "a=b"])).toBe("A=민지\nB=a=b");
  });
});

describe("payload v2 형식", () => {
  it("범례 몫: 멤버 300명이어도 total + PROMPT_RESERVE_TOKENS가 입력 예산 안이다", () => {
    const messages = syntheticGroupChat(300, 3);
    const inputBudget = 60_000;
    const p = buildPayloadForBudget({ messages, tone: "fact", concept: "group", kind: "group", inputBudget, tokensPerChar: 1 });
    expect(p.members.length).toBe(300);
    expect(payloadTokens(p, 1).total + PROMPT_RESERVE_TOKENS).toBeLessThanOrEqual(inputBudget);
  });

  it("바이트 상한: 한글 200만 자 대화도 JSON이 MAX_PAYLOAD_BYTES 이하다", () => {
    const rows: Raw[] = Array.from({ length: 20_000 }, (_, i): Raw => [i % 2 ? "P2" : "P1", kst(2026, 1, 1, 9) + i * MIN, "가".repeat(100)]);
    const p = buildPayloadForBudget({
      messages: chat(rows),
      tone: "fact",
      concept: "group",
      kind: "group",
      inputBudget: 400_000,
      tokensPerChar: 0.1,
    });
    expect(p.msgSent).toBeGreaterThan(1000);
    expect(new TextEncoder().encode(JSON.stringify(p)).length).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
  });

  it("readBlock: 메시지 줄은 기호와 날짜 헤더를 돌려준다", () => {
    const [h, m, bad, bundle] = readBlock("# 2026-10-01\nm7|09:05|AB|안녕|여기\nm8|09:05|a|x\nm9+2|09:06|A|가 ¦ 나 ¦ 다");
    expect(h).toEqual({ type: "header", date: "2026-10-01" });
    expect(m).toEqual({ type: "message", ref: "m7", id: 7, more: 0, time: "09:05", code: "AB", body: "안녕|여기", header: "2026-10-01" });
    expect(bad).toEqual({ type: "bad" });
    // v2.7: 묶음 줄은 m<번호>+<k>(k개 더)
    expect(bundle).toEqual({ type: "message", ref: "m9", id: 9, more: 2, time: "09:06", code: "A", body: "가 ¦ 나 ¦ 다", header: "2026-10-01" });
    expect(readBlock("# 2026-10-01\nm9+0|09:06|A|가")[1]).toEqual({ type: "bad" });
  });
});

// ===== v2.7: 같은 예산으로 더 많이 읽기(연속 메시지 묶기, 미디어·짧은 반응 접기) =====

describe("isReaction·foldedCount", () => {
  it("짧은 반응: 자모·기호만이고 REACTION_MAX_CHARS자 이하", () => {
    for (const s of ["ㅋㅋ", "ㅇㅇ", "ㄷㄷ", "ㅠㅠ", "ㄱㄱ", "ㅇㅋ", "?", "!!", "~", "^^", "ㅋㅋ ⏎ ㅋㅋ", "😂😂", "ㅋ".repeat(REACTION_MAX_CHARS)]) {
      expect([s, isReaction(s)]).toEqual([s, true]);
    }
    for (const s of ["ㅋㅋ 진짜", "ㅋㅋ5", "응", "ㅋㅋx5", "ㅋㅋ×5", "ㅋ".repeat(REACTION_MAX_CHARS + 1), "", " ", "[사진]", "a ¦ b"]) {
      expect([s, isReaction(s)]).toEqual([s, false]);
    }
  });

  it("묶음 줄의 칸: 접은 미디어·반응은 그 메시지 수, 글은 null", () => {
    expect(foldedCount("[사진]")).toBe(1);
    expect(foldedCount("[사진×3]")).toBe(3);
    expect(foldedCount("[삭제된 메시지×2]")).toBe(2);
    expect(foldedCount("ㅋㅋ×5")).toBe(5);
    expect(foldedCount("ㅋㅋ")).toBe(1);
    for (const s of ["치킨?", "ㅋㅋx5", "[사진x3]", "[링크:youtube.com]", "[가림:전화]", "ㅋㅋ 진짜×2"]) expect([s, foldedCount(s)]).toEqual([s, null]);
  });
});

describe("buildPayload v2.7: 다 들어가면 예전 줄 모양, 모자라면 묶고 접는다", () => {
  const group = (messages: ChatMessage[], tokenBudget: number, compact?: boolean) =>
    buildPayload({ messages, tone: "warm", concept: "group", kind: "group", tokenBudget, tokensPerChar: 1, ...(compact === undefined ? {} : { compact }) });
  /** 한 줄에 하나씩(예전 모양)으로 대화 전체를 보낸 transcript의 비용 */
  const plainCost = (messages: ChatMessage[]) => payloadTokens(group(messages, 10_000_000), 1).text;
  const t = (h: number, mi: number, d = 1) => kst(2026, 10, d, h, mi);

  // 0~4: A가 같은 분에 글 둘·사진 둘·반응 하나. 5: B. 6: B의 혼자 반응(3분 뒤). 7: A의 혼자 반응(앞 줄이 B). 8~9: 구분자·×숫자가 든 글
  const rows: Raw[] = [
    ["P1", t(9, 0), "오늘 저녁 뭐 먹을까?"],
    ["P1", t(9, 0), "치킨?"],
    ["P1", t(9, 0), "", "photo"],
    ["P1", t(9, 0), "", "photo"],
    ["P1", t(9, 0), "ㅋㅋ"],
    ["P2", t(9, 0), "좋아"],
    ["P2", t(9, 3), "ㅋㅋㅋ"],
    ["P1", t(9, 4), "ㅇㅇ"],
    ["P1", t(9, 5), "a ¦ b"],
    ["P1", t(9, 5), "ㅋㅋ×5"],
    ["P2", t(9, 6), "끝"],
  ];
  const messages = chat(rows);

  it("대화 전체가 한 줄에 하나씩 들어가면 예전 줄 모양 그대로다(묶지도 접지도 않는다)", () => {
    const p = group(messages, 10_000_000);
    expect(lines(p.transcript)).toEqual([
      "# 2026-10-01",
      "m0|09:00|A|오늘 저녁 뭐 먹을까?",
      "m1|09:00|A|치킨?",
      "m2|09:00|A|[사진]",
      "m3|09:00|A|[사진]",
      "m4|09:00|A|ㅋㅋ",
      "m5|09:00|B|좋아",
      "m6|09:03|B|ㅋㅋㅋ",
      "m7|09:04|A|ㅇㅇ",
      "m8|09:05|A|a ¦ b",
      "m9|09:05|A|ㅋㅋ×5",
      "m10|09:06|B|끝",
    ]);
    expect(p.msgSent).toBe(11);
  });

  it("모자라면 1단계: 같은 사람이 같은 분에 연달아 보낸 메시지를 한 줄로 묶는다(m<번호>+<k>, 구분자 ' ¦ '). 혼자인 반응·미디어는 그대로 둔다", () => {
    const p = group(messages, plainCost(messages) - 1);
    expect(lines(p.transcript)).toEqual([
      "# 2026-10-01",
      `m0+4|09:00|A|오늘 저녁 뭐 먹을까?${BUNDLE_SEP}치킨?${BUNDLE_SEP}[사진×2]${BUNDLE_SEP}ㅋㅋ`,
      "m5|09:00|B|좋아",
      "m6|09:03|B|ㅋㅋㅋ",
      "m7|09:04|A|ㅇㅇ",
      // 글 안의 구분자 글자는 전각으로, 접은 반응처럼 보이는 ×숫자는 x로 바꾼다(묶음 칸 수가 어긋나지 않게)
      `m8+1|09:05|A|a ￤ b${BUNDLE_SEP}ㅋㅋx5`,
      "m10|09:06|B|끝",
    ]);
    expect(p.msgSent).toBe(11);
    expect(p.msgTotal).toBe(11);
    expect(validatePayload(p).ok).toBe(true);
  });

  it("그래도 모자라면 2단계: 혼자인 반응·미디어는 같은 사람의 바로 앞 줄 끝에 접고, 접을 곳이 없으면 뺀다", () => {
    const bundled = payloadTokens(group(messages, plainCost(messages) - 1), 1).text;
    const p = group(messages, bundled - 1);
    expect(lines(p.transcript)).toEqual([
      "# 2026-10-01",
      `m0+4|09:00|A|오늘 저녁 뭐 먹을까?${BUNDLE_SEP}치킨?${BUNDLE_SEP}[사진×2]${BUNDLE_SEP}ㅋㅋ`,
      // B의 3분 뒤 반응은 B의 바로 앞 줄에 접는다
      `m5+1|09:00|B|좋아${BUNDLE_SEP}ㅋㅋㅋ`,
      // A의 m7(앞 줄이 B)은 접을 곳이 없어 뺐다
      `m8+1|09:05|A|a ￤ b${BUNDLE_SEP}ㅋㅋx5`,
      "m10|09:06|B|끝",
    ]);
    expect(p.msgSent).toBe(10);
    expect(validatePayload(p).ok).toBe(true);
  });

  it("payloadIndex: 묶음의 글 메시지마다 제 번호·보낸 사람·시각·본문이 남고, 접은 미디어·반응은 근거로 쓰지 않는다", () => {
    const bundled = payloadTokens(group(messages, plainCost(messages) - 1), 1).text;
    const idx = payloadIndex(group(messages, bundled - 1));
    const at = (mi: number) => `2026-10-01T09:${String(mi).padStart(2, "0")}:00+09:00`;
    expect([...idx]).toEqual([
      ["m0", { sender: "P1", at: at(0), text: "오늘 저녁 뭐 먹을까?", lineRef: "m0" }],
      ["m1", { sender: "P1", at: at(0), text: "치킨?", lineRef: "m0" }],
      ["m5", { sender: "P2", at: at(0), text: "좋아", lineRef: "m5" }],
      ["m8", { sender: "P1", at: at(5), text: "a ￤ b", lineRef: "m8" }],
      ["m9", { sender: "P1", at: at(5), text: "ㅋㅋx5", lineRef: "m8" }],
      ["m10", { sender: "P2", at: at(6), text: "끝" }],
    ]);
  });

  it("compact: false면 예산이 모자라도 예전처럼 한 줄에 하나씩 고른다(측정용)", () => {
    const p = group(messages, plainCost(messages) - 1, false);
    expect(p.transcript).not.toContain("+");
    expect(p.msgSent).toBeLessThan(11);
  });

  it("같은 분의 같은 반응은 1단계에서도 ×n으로 접고, 2단계는 ㅋ 개수가 달라도 같은 반응으로 접는다", () => {
    const m = chat([
      ["P1", t(9, 0), "웃기다"],
      ["P1", t(9, 0), "ㅋㅋ"],
      ["P1", t(9, 0), "ㅋㅋ"],
      ["P1", t(9, 0), "ㅋㅋㅋㅋ"],
      ["P1", t(9, 0), "ㅠㅠ"],
      ["P2", t(9, 1), "뭐가"],
      ["P2", t(9, 30), "", "emoticon"],
    ]);
    const one = group(m, plainCost(m) - 1);
    expect(lines(one.transcript).slice(1)).toEqual([
      `m0+4|09:00|A|웃기다${BUNDLE_SEP}ㅋㅋ×2${BUNDLE_SEP}ㅋㅋㅋㅋ${BUNDLE_SEP}ㅠㅠ`,
      "m5|09:01|B|뭐가",
      "m6|09:30|B|[이모티콘]",
    ]);
    const two = group(m, payloadTokens(one, 1).text - 1);
    expect(lines(two.transcript).slice(1)).toEqual([
      `m0+4|09:00|A|웃기다${BUNDLE_SEP}ㅋㅋ×3${BUNDLE_SEP}ㅠㅠ`,
      `m5+1|09:01|B|뭐가${BUNDLE_SEP}[이모티콘]`,
    ]);
    expect([one.msgSent, two.msgSent]).toEqual([7, 7]);
  });

  it("마지막 메시지는 접을 곳이 없어도 빼지 않는다(transcript는 늘 마지막 메시지로 끝난다)", () => {
    const m = chat([
      ["P1", t(9, 0), "안녕"],
      ["P2", t(9, 1), "ㅋㅋ"],
      ["P2", t(9, 5), "뭐해"],
      ["P1", t(9, 10), "ㅋㅋ"],
    ]);
    const p = group(m, plainCost(m) - 1);
    expect(lines(p.transcript).slice(1)).toEqual(["m0|09:00|A|안녕", "m2|09:05|B|뭐해", "m3|09:10|A|ㅋㅋ"]);
    expect(p.msgSent).toBe(3);
  });

  it("날짜가 바뀌거나 메시지 번호가 이어지지 않으면(사이에 알림) 묶지도 접지도 않는다", () => {
    const m = chat([
      ["P1", t(23, 59, 1), "자기 전에"],
      ["P1", t(0, 0, 2), "", "photo"],
      ["P2", t(0, 1, 2), "아직 안 잤어?"],
      [null, t(0, 1, 2), "P3님이 들어왔습니다."],
      ["P2", t(0, 1, 2), "나도"],
      ["P1", t(0, 2, 2), "끝"],
    ]);
    const p = group(m, plainCost(m) - 1);
    expect(lines(p.transcript)).toEqual(["# 2026-10-01", "m0|23:59|A|자기 전에", "# 2026-10-02", "m2|00:01|B|아직 안 잤어?", "m4|00:01|B|나도", "m5|00:02|A|끝"]);
    expect(validatePayload(p).ok).toBe(true);
  });

  it(`묶음 한 줄은 칸 ${BUNDLE_MAX_PARTS}개·본문 ${BUNDLE_MAX_CHARS}자까지다. 그보다 긴 메시지 하나는 혼자 한 줄이다`, () => {
    const many: Raw[] = Array.from({ length: BUNDLE_MAX_PARTS + 4 }, (_, i): Raw => ["P1", t(9, 0), `말${i}`]);
    const long = "가".repeat(BUNDLE_MAX_CHARS + 50);
    const m = chat([...many, ["P1", t(9, 0), long], ["P1", t(9, 0), "또 짧게"], ["P2", t(9, 1), "끝"]]);
    const p = group(m, plainCost(m) - 1);
    const heads = lines(p.transcript).slice(1).map((l) => l.split("|")[0]);
    expect(heads).toEqual([`m0+${BUNDLE_MAX_PARTS - 1}`, `m${BUNDLE_MAX_PARTS}+3`, `m${BUNDLE_MAX_PARTS + 4}`, `m${BUNDLE_MAX_PARTS + 5}`, `m${BUNDLE_MAX_PARTS + 6}`]);
    for (const l of lines(p.transcript).slice(1, 3)) expect(l.length).toBeLessThan(BUNDLE_MAX_CHARS + 20);
    expect(validatePayload(p).ok).toBe(true);
  });
});

describe("buildPayload v2.7: 몰아 보내는 큰 단톡방(전체 기간에서 고를 때)", () => {
  const messages = syntheticBurstyChat({ people: 6, days: 150 });
  const byId = new Map(messages.map((m) => [m.id, m]));
  const group = (tokenBudget: number, compact = true) =>
    buildPayload({ messages, tone: "warm", concept: "group", kind: "group", tokenBudget, tokensPerChar: 1, compact });
  /** 줄마다 덮는 메시지 번호 구간 */
  const covered = (block: string) => readBlock(block).flatMap((l) => (l.type === "message" ? Array.from({ length: l.more + 1 }, (_, k) => l.id + k) : []));

  it("예산을 넘지 않고, 모든 달이 들고, 마지막 메시지로 끝나고, msgSent는 줄이 덮는 원본 메시지 수다", () => {
    for (const budget of [20_000, 60_000]) {
      const p = group(budget);
      expect([budget, payloadTokens(p, 1).text <= budget]).toEqual([budget, true]);
      expect([budget, payloadTokens(p, 1).text > budget * 0.9]).toEqual([budget, true]);
      expect([budget, validatePayload(p).ok]).toEqual([budget, true]);
      const ids = covered(p.transcript);
      expect(p.msgSent).toBe(ids.length);
      expect(ids.at(-1)).toBe(messages.at(-1)!.id);
      const months = new Set(messages.map((m) => new Date(m.ts + 9 * HOUR).toISOString().slice(0, 7)));
      expect(new Set(sentLines(p.transcript).map((l) => l.day.slice(0, 7)))).toEqual(months);
      // 덮는 번호는 모두 원본 메시지이고, 빠진 메시지(접을 곳 없는 반응·미디어)는 덮지 않는다
      for (const id of ids) expect(byId.get(id)?.sender).not.toBeNull();
    }
  });

  it("msg_id 왕복: payloadIndex의 번호마다 원본 메시지의 보낸 사람·분 단위 시각·본문이 그대로다", () => {
    const p = group(40_000);
    const idx = payloadIndex(p);
    expect(idx.size).toBeGreaterThan(500);
    for (const [ref, line] of idx) {
      const m = byId.get(Number(ref.slice(1)))!;
      expect([ref, m.kind, isReaction(m.text)]).toEqual([ref, "text", false]);
      expect([ref, line.sender]).toEqual([ref, m.sender]);
      expect([ref, line.at]).toEqual([ref, `${iso(m.ts).slice(0, 16)}:00+09:00`]);
      expect([ref, line.text]).toEqual([ref, m.text.replace(/\n/g, " ⏎ ")]);
    }
    // 접은 것만 든 줄은 마지막 줄뿐이다(혼자인 반응·미디어는 앞 줄에 접거나 뺀다)
    const bodies = readBlock(p.transcript).flatMap((l) => (l.type === "message" ? [l.body] : []));
    for (const b of bodies.slice(0, -1)) expect(b.split(BUNDLE_SEP).some((part) => foldedCount(part) === null)).toBe(true);
  });

  it("회귀: 같은 예산에서 한 줄에 하나씩일 때보다 원본 메시지를 20% 넘게 더 보낸다", () => {
    for (const budget of [20_000, 60_000]) {
      const before = group(budget, false).msgSent;
      const after = group(budget).msgSent;
      expect([budget, after >= before * 1.2]).toEqual([budget, true]);
    }
  });

  it("예산을 0.95배로 줄이면(413 재요청) 보내는 몫도 줄어든다", () => {
    const a = group(60_000);
    const b = group(57_000);
    expect(payloadTokens(b, 1).text).toBeLessThan(payloadTokens(a, 1).text);
    expect(b.msgSent).toBeLessThanOrEqual(a.msgSent);
  });
});

describe("buildPayload v2.7: 까다로운 본문 섞어 보기", () => {
  // 구분자·×숫자·미디어 표시처럼 보이는 글, 링크·전화번호, 줄바꿈, 그림 문자, 긴 글, 시스템 알림(번호 건너뜀)
  const BODIES = ["a ¦ b", "ㅋㅋ×5", "[사진×2]", "[사진]", "ㅋㅋ ¦ ㅋㅋ", "봐 https://youtu.be/x 010-1234-5678", "첫 줄\n둘째 줄", "😂😂", "ㅋㅋ", "ㅇㅇ", "?", "응 그래", "가".repeat(400), "ㅋ×ㅋ×3", "이거 ×2 해"];
  const KINDS: ChatMessage["kind"][] = ["photo", "emoticon", "video", "deleted", "file"];

  it("시드마다 아무렇게나 섞은 대화도 예산마다 validatePayload를 통과하고, payloadIndex 번호의 보낸 사람·본문이 원본과 맞는다", () => {
    for (let seed = 1; seed <= 40; seed++) {
      let x = seed;
      const rnd = (k: number) => ((x = (x * 1103515245 + 12345) & 0x7fffffff) % k);
      const rows: Raw[] = [];
      let ts = kst(2026, 10, 1, 9);
      for (let i = 0; i < 120; i++) {
        ts += [0, 0, 0, 60_000, 300_000, 8 * HOUR][rnd(6)];
        const r = rnd(10);
        if (r === 0) rows.push([null, ts, "P3님이 들어왔습니다."]);
        else if (r < 3) rows.push([`P${1 + rnd(3)}`, ts, "", KINDS[rnd(KINDS.length)]]);
        else rows.push([`P${1 + rnd(3)}`, ts, BODIES[rnd(BODIES.length)]]);
      }
      const messages = chat(rows);
      const byId = new Map(messages.map((m) => [m.id, m]));
      const full = payloadTokens(buildPayload({ messages, tone: "fact", concept: "group", kind: "group", tokenBudget: 1e9, tokensPerChar: 1 }), 1).text;
      for (const share of [0.97, 0.85, 0.6, 0.3]) {
        const budget = Math.floor(full * share);
        const p = buildPayload({ messages, tone: "fact", concept: "group", kind: "group", tokenBudget: budget, tokensPerChar: 1 });
        const r = validatePayload(p);
        expect([seed, share, r.ok ? "ok" : r.error]).toEqual([seed, share, "ok"]);
        expect([seed, share, payloadTokens(p, 1).text <= budget]).toEqual([seed, share, true]);
        for (const [ref, line] of payloadIndex(p)) {
          const m = byId.get(Number(ref.slice(1)))!;
          expect([seed, ref, line.sender]).toEqual([seed, ref, m.sender]);
          // 한 메시지 줄의 미디어는 표시 그대로다. 묶음 안 글은 구분자 글자만 전각으로, ×숫자 꼬리만 x로 바뀐다
          const marks: Partial<Record<ChatMessage["kind"], string>> = { photo: "[사진]", emoticon: "[이모티콘]", video: "[동영상]", deleted: "[삭제된 메시지]", file: "[파일]" };
          const body = m.kind === "text" ? maskPII(m.text.replace(/\n/g, " ⏎ ")).text : marks[m.kind]!;
          const ok = line.text === body || line.text === body.replaceAll("¦", "￤") || line.text === body.replaceAll("¦", "￤").replace(/×(?=\d+\]?$)/, "x");
          expect([seed, ref, ok]).toEqual([seed, ref, true]);
        }
      }
    }
  });
});
