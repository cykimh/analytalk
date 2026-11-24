import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/lib/parse/parse";
import { ANCHOR_BUDGET_SHARE, PROMPT_RESERVE_TOKENS } from "@/lib/config";
import { computeStats } from "@/lib/stats/compute";
import { statsForPrompt } from "@/lib/stats/view";
import { syntheticGroupChat } from "@/test/syntheticChat";
import { buildPayload, buildPayloadForBudget, payloadIndex, payloadTokens } from "./build";
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

const REAL = ["김민지", "민지폰", "이철수", "박영희", "민지", "철수", "영희"];
const MAP: NameMap = { 김민지: "P1", 민지폰: "P1", 이철수: "P2", 박영희: "P3" };

/** 원래 이름으로 된 3일치 대화(하루 100개)를 이름 정리까지 거친다 */
function named(): ChatMessage[] {
  const rows: Raw[] = [[null, kst(2026, 10, 1, 8), "박영희님이 들어왔습니다."]];
  for (let day = 1; day <= 3; day++) {
    for (let i = 0; i < 100; i++) {
      const sender = ["김민지", "이철수", "민지폰"][i % 3];
      const text = ["김민지야 뭐해", "철수랑 영화 보자", "영희 나갔대", "민지폰으로 보냄", "ㅋㅋ 내일 봐"][i % 5];
      rows.push([sender, kst(2026, 10, day, 9) + i * MIN, text]);
    }
  }
  const r = applyDisplayNames(chat(rows), MAP, ["박영희"], [["김민지", "민지폰"]]);
  if (!r.ok) throw new Error(r.reason);
  return r.messages;
}

const build = (messages: ChatMessage[], tokenBudget = 1_000_000, anchorShare?: number) =>
  buildPayload({ messages, me: "P1", concept: "couple", kind: "pair", tokenBudget, tokensPerChar: 1, anchorShare });
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

  it("JSON 전체에 원래 이름이 0건", () => {
    const json = JSON.stringify(build(named(), 2000));
    for (const name of REAL) expect([name, json.includes(name)]).toEqual([name, false]);
  });

  it("별칭 둘을 합치면 stats.byPerson 키가 1개", () => {
    const raw = chat([
      ["김민지", kst(2026, 10, 1, 9), "폰에서"],
      ["민지폰", kst(2026, 10, 1, 9, 1), "PC에서"],
    ]);
    const r = applyDisplayNames(raw, { 김민지: "P1", 민지폰: "P1" }, [], [["김민지", "민지폰"]]);
    if (!r.ok) throw new Error(r.reason);
    const p = build(r.messages);
    expect(Object.keys(p.stats.byPerson)).toEqual(["P1"]);
    expect(p.members).toEqual(["P1"]);
  });

  it("줄 형식, 날짜 헤더, 본문 처리(미디어·꺾쇠·줄바꿈·민감·개인정보)", () => {
    const messages = chat([
      [null, kst(2026, 10, 1, 8), "P2님이 들어왔습니다."],
      ["P1", kst(2026, 10, 1, 9, 5), "사진", "photo"],
      ["P2", kst(2026, 10, 1, 23, 59), "a<b>c"],
      ["P1", kst(2026, 10, 2, 0, 1), "첫 줄\n둘째 줄"],
      ["P2", kst(2026, 10, 2, 0, 2), "어제 우울증 진단 받았어"],
      ["P1", kst(2026, 10, 2, 0, 3), "내 번호 010-1234-5678"],
    ]);
    const p = build(messages);
    expect(lines(p.transcript)).toEqual([
      "# 2026-10-01",
      "m1|10-01 09:05|P1|[사진]",
      "m2|10-01 23:59|P2|a＜b＞c",
      "# 2026-10-02",
      "m3|10-02 00:01|P1|첫 줄 ⏎ 둘째 줄",
      "m4|10-02 00:02|P2|[가림:민감]",
      "m5|10-02 00:03|P1|내 번호 [가림:전화]",
    ]);
    expect(p.anchors).toBe("");
    expect(p.maskCounts).toEqual({ phone: 1, email: 0, account: 0, rrn: 0, url: 0, sensitive: 1 });
    expect(p).toMatchObject({ v: 1, concept: "couple", kind: "pair", me: "P1", members: ["P1", "P2"], msgTotal: 5, msgSent: 5 });
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

  it("anchors: 첫 메시지 100개 + 메시지 수 상위 3일, transcript와 겹치는 것은 뺀다", () => {
    // 날짜별 개수. 상위 3일은 10일(90), 5일(80), 7일(60)
    const perDay: Record<number, number> = { 1: 30, 2: 50, 3: 30, 4: 10, 5: 80, 6: 10, 7: 60, 8: 10, 9: 10, 10: 90 };
    const rows: Raw[] = [];
    const byDay: Record<number, number[]> = {};
    for (const [day, n] of Object.entries(perDay)) {
      for (let i = 0; i < n; i++) {
        (byDay[Number(day)] ??= []).push(rows.length);
        rows.push([i % 2 ? "P1" : "P2", kst(2026, 10, Number(day), 10) + i * MIN, "ㅇㅇ"]);
      }
    }
    // anchors 몫을 넉넉히 줘서 고르는 범위만 본다(예산 상한은 아래 테스트)
    const p = build(chat(rows), 8000, 0.95);
    const sent = new Set(ids(p.transcript));
    const anchored = ids(p.anchors);

    expect(sent.size).toBeGreaterThan(0);
    expect(sent.size).toBeLessThan(perDay[10]);
    const expected = [...Array(100).keys()]
      .concat(byDay[5], byDay[7], byDay[10])
      .filter((id, i, all) => all.indexOf(id) === i && !sent.has(id))
      .sort((a, b) => a - b);
    expect(anchored).toEqual(expected);
    expect(lines(p.anchors).filter((l) => l.startsWith("# "))).toEqual([
      "# 2026-10-01",
      "# 2026-10-02",
      "# 2026-10-03",
      "# 2026-10-05",
      "# 2026-10-07",
      "# 2026-10-10",
    ]);
  });

  it("활발한 단톡방: anchors는 예산 × ANCHOR_BUDGET_SHARE 안에서 묶음마다 담고, 예산을 줄이면 전체도 줄어든다", () => {
    // 평소 60일 × 20개 + 상위 3일 × 1,500개. 상위 날짜만 해도 예산의 몇 배다
    const rows: Raw[] = [];
    const busy = new Set([10, 30, 50]);
    for (let day = 0; day < 60; day++) {
      const n = busy.has(day) ? 1500 : 20;
      for (let i = 0; i < n; i++) {
        rows.push([`P${(i % 4) + 1}`, kst(2026, 1, 1, 9) + day * 86_400_000 + i * 20_000, `오늘 ${day}일 ${i}번째 이야기`]);
      }
    }
    const messages = chat(rows);
    const dayOf = (id: number) => new Date(messages[id].ts + 9 * 3_600_000).toISOString().slice(0, 10);
    const busyDays = [...busy].map((d) => dayOf(rows.findIndex((r) => r[1] >= kst(2026, 1, 1, 9) + d * 86_400_000)));

    let budget = 50_000;
    let prevText = Infinity;
    for (let round = 0; round < 3; round++) {
      const p = buildPayload({ messages, me: "P1", concept: "group", kind: "group", tokenBudget: budget, tokensPerChar: 1 });
      const { text, total } = payloadTokens(p, 1);
      expect(text).toBeLessThanOrEqual(budget);
      expect(text).toBeGreaterThan(budget * 0.95);
      expect(tokens(p.anchors)).toBeLessThanOrEqual(budget * ANCHOR_BUDGET_SHARE);
      expect(total).toBe(text + JSON.stringify(statsForPrompt(p.stats)).length);
      expect(text).toBeLessThan(prevText);
      // 첫 대화와 상위 3일이 모두 조금씩 들어 있다
      const anchored = ids(p.anchors);
      expect(anchored[0]).toBe(0);
      for (const d of busyDays) expect(anchored.some((id) => dayOf(id) === d)).toBe(true);
      expect(lines(p.transcript).at(-1)).toMatch(new RegExp(`^m${messages.length - 1}\\|`));
      // T10의 413 재요청처럼 예산을 0.95배로 줄인다
      prevText = text;
      budget = Math.floor(budget * 0.95);
    }
  });

  it("시스템 메시지뿐이면 던진다", () => {
    expect(() => build(chat([[null, kst(2026, 10, 1, 8), "P1님이 들어왔습니다."]]))).toThrow("보낼 메시지가 없다");
  });
});

describe("buildPayload: 마지막 메시지 한 줄이 예산보다 길 때", () => {
  const MSG = /^m(\d+)\|\d{2}-\d{2} \d{2}:\d{2}\|[^|]+\|(.*)$/;
  /** transcript의 메시지 줄 본문들 */
  const bodies = (block: string) => lines(block).flatMap((l) => MSG.exec(l)?.slice(2) ?? []);
  const group = (messages: ChatMessage[], tokenBudget: number) =>
    buildPayload({ messages, me: "P1", concept: "group", kind: "group", tokenBudget, tokensPerChar: 1 });

  it("5000자 메시지 1건, 예산 1,000: 본문을 잘라 …로 끝내고 transcript에 1건 넣는다", () => {
    const text = "오늘 있었던 일을 길게 적어 볼게 ".repeat(300).slice(0, 5000);
    const p = group(chat([["P1", kst(2026, 10, 1, 9), text]]), 1000);
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
        const p = group(chat([["P1", kst(2026, 10, 1, 9), "가".repeat(940 + k) + tail + "나".repeat(200)]]), 1000);
        const r = validatePayload(p);
        expect([tail, k, r.ok ? "ok" : r.error]).toEqual([tail, k, "ok"]);
        expect(bodies(p.transcript)[0]).toMatch(/…$/);
      }
    }
  });

  it("잘라도 날짜 헤더와 줄 머리조차 안 들어가는 예산이면 던진다", () => {
    expect(() => group(chat([["P1", kst(2026, 10, 1, 9), "가".repeat(100)]]), 20)).toThrow();
  });
});

describe("payloadTokens", () => {
  it("total = text + 모델에게 보이는 stats(statsForPrompt) JSON 글자 수 × tokensPerChar", () => {
    const messages = syntheticGroupChat(20, 18);
    const p = buildPayload({ messages, me: "멤버01", concept: "group", kind: "group", tokenBudget: 5000, tokensPerChar: 1 });
    const view = JSON.stringify(statsForPrompt(p.stats)).length;
    const text = tokens(p.anchors) + tokens(p.transcript);
    expect(view).toBeLessThan(JSON.stringify(p.stats).length);
    expect(payloadTokens(p, 1)).toEqual({ text, total: text + view });
    expect(payloadTokens(p, 0.5).total).toBe((text + view) * 0.5);
  });
});

describe("buildPayloadForBudget", () => {
  const messages = syntheticGroupChat(40, 60);
  const statsChars = JSON.stringify(statsForPrompt(computeStats(messages))).length;
  const forBudget = (inputBudget: number, tokensPerChar = 1) =>
    buildPayloadForBudget({ messages, me: "멤버01", concept: "group", kind: "group", inputBudget, tokensPerChar });

  it("40명 × 60개월, 입력 예산 128,000: 통계 요약·프롬프트 몫까지 예산 안이고 transcript가 있다", () => {
    const p = forBudget(128_000);
    const { text, total } = payloadTokens(p, 1);
    expect(total + PROMPT_RESERVE_TOKENS).toBeLessThanOrEqual(128_000);
    expect(total + PROMPT_RESERVE_TOKENS).toBeGreaterThan(128_000 * 0.97);
    expect(text).toBeLessThanOrEqual(128_000 - PROMPT_RESERVE_TOKENS - statsChars);
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
    const edge = PROMPT_RESERVE_TOKENS + statsChars + 1000;
    expect(payloadTokens(forBudget(edge), 1).text).toBeLessThanOrEqual(1000);
    expect(() => forBudget(edge - 1)).toThrow();
  });

  it("시스템 메시지뿐이면 buildPayload와 같이 던진다", () => {
    const only = chat([[null, kst(2026, 10, 1, 8), "P1님이 들어왔습니다."]]);
    expect(() =>
      buildPayloadForBudget({ messages: only, me: "P1", concept: "group", kind: "group", inputBudget: 128_000, tokensPerChar: 1 }),
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

  it("anchors와 transcript의 메시지를 모두 담는다", () => {
    const p = build(named(), 5000);
    const idx = payloadIndex(p);
    expect(idx.size).toBe(ids(p.anchors).length + p.msgSent);
    expect(idx.has("m1")).toBe(true);
  });
});
