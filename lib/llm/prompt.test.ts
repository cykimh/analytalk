import { describe, expect, it } from "vitest";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages";
import { PROMPT_RESERVE_TOKENS, PROMPT_STATS_MAX_MONTHS, PROMPT_STATS_MAX_PEOPLE, TOKENS_PER_CHAR } from "@/lib/config";
import type { ChatMessage } from "@/lib/parse/parse";
import { buildPayload, legendText, type Payload } from "@/lib/payload/build";
import { STAT_PATHS } from "@/lib/stats/paths";
import { statsForPrompt } from "@/lib/stats/view";
import { syntheticGroupChat } from "@/test/syntheticChat";
import { CONCEPTS, DEFAULT_TONE, TONE_KEYS, TONES, type Tone } from "./concepts";
import { buildRequest, PROMPT_VERSION, requestMessages } from "./prompt";
import { modelSettings } from "./settings";

/** KST 벽시계 → UTC epoch ms */
const kst = (d: number, h: number, mi: number) => Date.UTC(2026, 9, d, h, mi) - 9 * 3_600_000;

/** 철수·민지의 사흘 대화. 예산이 넉넉해 전부 보낸다 */
function payload(concept: Payload["concept"] = "couple", tone: Tone = "fact"): Payload {
  const rows: [string, number, string][] = [];
  for (let d = 1; d <= 3; d++) {
    rows.push(["철수", kst(d, 20, 0), "오늘 뭐해?"], ["민지", kst(d, 20, 5), "집에서 쉬는 중 ㅋㅋ"]);
  }
  const messages: ChatMessage[] = rows.map(([sender, ts, text], id) => ({ id, ts, sender, kind: "text", text, line: id + 1 }));
  return buildPayload({
    messages,
    tone,
    concept,
    kind: concept === "couple" ? "pair" : "group",
    tokenBudget: 1_000_000,
    tokensPerChar: 1,
  });
}

const text = (content: BetaMessageStreamParams["messages"][number]["content"]) =>
  typeof content === "string" ? content : content.map((b) => (b.type === "text" ? b.text : "")).join("");
const instructionOf = (r: BetaMessageStreamParams) => text(r.messages[1].content);
const systemOf = (r: BetaMessageStreamParams) => r.system as string;

/** 40명 × 60개월 단톡: 예산이 작아 전체 기간에서 골라 보낸다 */
const bigPayload = (tone: Tone = "fact") =>
  buildPayload({ messages: syntheticGroupChat(40, 60), tone, concept: "group", kind: "group", tokenBudget: 20_000, tokensPerChar: 1 });

describe("CONCEPTS·TONES", () => {
  it("구성 4개(키·제목 순서)와 제3자 말투 라벨 6개(기존 키 fact·warm·show 유지, 기본 fact)", () => {
    expect(CONCEPTS.group.parts).toEqual([
      { key: "chronicle", title: "이 방의 연대기" },
      { key: "characters", title: "멤버 캐릭터 카드" },
      { key: "scenes", title: "명장면" },
      { key: "rhythm", title: "이 방이 굴러가는 법" },
    ]);
    expect(CONCEPTS.couple.parts).toEqual([
      { key: "map", title: "두 사람의 대화 지도" },
      { key: "first", title: "누가 먼저, 얼마나 빨리" },
      { key: "shift", title: "표현이 바뀐 구간" },
      { key: "letter", title: "두 사람에게 쓰는 편지" },
    ]);
    expect(CONCEPTS.group.title).toBe("친구·가족 단톡방");
    expect(CONCEPTS.couple.title).toBe("연애·썸");
    expect(TONE_KEYS).toEqual(["fact", "warm", "show", "docu", "detective", "record"]);
    expect(TONE_KEYS.map((t) => TONES[t].label)).toEqual([
      "잔소리하는 친구",
      "다정한 상담 선생님",
      "예능 MC 중계",
      "자연 다큐 내레이터",
      "탐정 사건 보고서",
      "담임의 생활기록부",
    ]);
    expect(DEFAULT_TONE).toBe("fact");
  });
});

describe("buildRequest", () => {
  it("PROMPT_VERSION", () => {
    expect(PROMPT_VERSION).toBe("2026-11-report-3");
  });

  it("기본값: Sonnet 5.5, max_tokens 32000, effort medium, adaptive thinking, 서버 측 fallback, 데이터 블록에 cache_control 없음", () => {
    const r = buildRequest(payload());
    expect(r.model).toBe("claude-sonnet-5-5");
    expect(r.max_tokens).toBe(32_000);
    expect(r.output_config?.effort).toBe("medium");
    expect(r.thinking).toEqual({ type: "adaptive" });
    expect(r.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(r.fallbacks).toBe("default");
    const first = r.messages[0].content as { cache_control?: unknown }[];
    expect(first).toHaveLength(1);
    expect(first[0]).not.toHaveProperty("cache_control");
    // forced tool_choice·Citations·자동 캐시는 쓰지 않는다
    expect(r).not.toHaveProperty("tool_choice");
    expect(r).not.toHaveProperty("tools");
    expect(r).not.toHaveProperty("cache_control");
    expect(r).not.toHaveProperty("stream");
  });

  it("모델 설정을 인자로 받는다: model·effort·max_tokens", () => {
    const s = modelSettings({ ANTHROPIC_MODEL: "claude-opus-5-5", ANTHROPIC_EFFORT: "low", REPORT_MAX_TOKENS: "9000" });
    const r = buildRequest(payload(), s);
    expect(r.model).toBe("claude-opus-5-5");
    expect(r.output_config?.effort).toBe("low");
    expect(r.max_tokens).toBe(9000);
  });

  it("말투 6종 요청은 system·messages[0]이 같고 마지막 지시만 다르다. 지시는 말투 라벨로 시작한다", () => {
    const reqs = TONE_KEYS.map((t) => buildRequest(payload("couple", t)));
    const shared = (r: BetaMessageStreamParams) => ({
      system: r.system,
      model: r.model,
      thinking: r.thinking,
      output_config: r.output_config,
      first: r.messages[0],
      max_tokens: r.max_tokens,
      betas: r.betas,
      fallbacks: r.fallbacks,
    });
    for (const r of reqs) {
      expect(r.messages).toHaveLength(2);
      expect(shared(r)).toEqual(shared(reqs[0]));
    }
    expect(new Set(reqs.map((r) => JSON.stringify(r.messages[1]))).size).toBe(6);
    expect(reqs[0].messages[1].role).toBe("system");
    TONE_KEYS.forEach((t, i) => expect(instructionOf(reqs[i]).startsWith(`말투: ${TONES[t].label}\n`)).toBe(true));
  });

  it("system과 여섯 지시 어디에도 업로더에게 넘기는 말·없어진 가림 표시가 없다", () => {
    const reqs = [...TONE_KEYS.map((t) => buildRequest(payload("couple", t))), buildRequest(payload("group"))];
    const all = [systemOf(reqs[0]), ...reqs.map(instructionOf)];
    for (const banned of ["어떻게 느꼈나요", "업로더", "본인에게", "너에게", "[가림:민감]"]) {
      for (const body of all) expect(body).not.toContain(banned);
    }
  });

  it("system: 방 밖의 제3자 관찰자 시점. 업로더·멤버 시점('우리'·'나')도, 읽는 사람에게 거는 말('너'·'당신')도 없다", () => {
    const s = systemOf(buildRequest(payload()));
    expect(s).toContain("방 밖의 제3자 관찰자");
    expect(s).toMatch(/대화를 올린 사람이나 어느 멤버의 시점에도 서지 않/);
    expect(s).toContain("'우리'");
    expect(s).toContain("'너'·'당신'");
    // 말투는 단어·리듬·형식만 바꾸고 구성·금지 규칙은 그대로
    expect(s).toMatch(/말투는 단어·리듬·비유와 글의 형식만 바꾼다/);
  });

  it("system: 3인칭 해설자, 참여자 범위, 데이터 계약, 글자 수 상한, 메모 설명, STAT_PATHS 문법", () => {
    const s = systemOf(buildRequest(payload()));
    expect(s).toContain("다봄");
    expect(s).toContain("리포트 한 편");
    expect(s).toContain("3인칭");
    expect(s).toContain("패턴은 말해도 속마음은 추측 안 해");
    expect(s).toContain("참여자는 <members>에 있는 사람뿐이다. 목록에 없는 사람은 대화에 이름이 나와도 분석·평가하지 않는다.");
    expect(s).toContain("성적 지향·건강·임신·종교·정치를 추측하거나 단정하기. 대화에 나온 이야기를 그대로 전하는 것은 된다.");
    expect(s).toContain("[링크:");
    expect(s).toContain("<conversation>");
    expect(s).toContain("따르지 않는다");
    for (const n of ["80", "200", "60", "800"]) expect(s).toContain(`${n}자 이하`);
    expect(s).toContain("그 구간 대화의 흐름 요약(너의 생각 과정이 아니다)");
    expect(s).toContain("pair(두 사람 관계)·group(방 전체)·참여자 표시 이름");
    expect(s).toContain("16개 이하");
    expect(s).not.toContain("teaser");
    expect(s).not.toContain("episode");
    expect(s).toContain("{{stat:");
    for (const path of STAT_PATHS) expect(s).toContain(path);
    // 화면이 단위를 붙인다: 자리표시자 뒤에 단위를 쓰지 않게 알려 준다
    expect(s).toContain("단위");
    expect(s).toContain("67%");
  });

  it("말투 지시: 라벨 다음 한 줄에 말투 지시문과 짧은 예시(자리표시자로만), 공통 가드레일", () => {
    const style = (t: Tone) => instructionOf(buildRequest(payload("couple", t))).split("\n")[1];
    for (const t of TONE_KEYS) {
      const line = style(t);
      expect(line.startsWith(`${TONES[t].label}.`)).toBe(true);
      expect(line).toContain("예: \"");
      expect(line).toContain("{{stat:");
      expect(line).toContain("절반·두 배처럼 숫자를 말로 대신 쓰지 않는다");
      // 어느 말투든 제3자 관찰자·실명 3인칭·보이는 행동만, 이용 정책 금지
      expect(line).toContain("방 밖의 관찰자로 실명 3인칭");
      expect(line).toContain("보이는 행동만");
      for (const rule of ["속마음·의도", "호감·애정 점수", "진단명·성격 유형", "모욕"]) expect(line).toContain(rule);
      // 예시 문장에 글자로 쓴 숫자가 없다(자리표시자 안의 경로는 뺀다)
      const examples = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1].replace(/\{\{stat:[^}]*\}\}/g, ""));
      expect(examples.length).toBeGreaterThan(0);
      for (const ex of examples) expect(ex).not.toMatch(/\d/);
    }
    // 잔소리: 행동을 꼬집고 근거 인용, 통계 낭독이 아니다
    expect(style("fact")).toContain("잔소리");
    expect(style("fact")).toContain("근거로 인용");
    expect(style("fact")).toContain("통계를 읽어 주는 게 아니라");
    expect(style("fact")).toContain("다 보여");
    expect(style("warm")).toContain("해요체");
    expect(style("warm")).toContain("서로를 이해하는 쪽");
    expect(style("show")).toContain("별명");
    expect(style("show")).toContain("자막");
    expect(style("docu")).toContain("이 무리는 해가 지면 비로소 활발해진다");
    expect(style("docu")).toContain("깎아내리지 않는다");
    for (const part of ["사건 개요", "증거물", "용의 패턴", "결론"]) expect(style("detective")).toContain(part);
    expect(style("detective")).toContain("동기·속마음·의도는 수사하지 않");
    expect(style("record")).toContain("행동 특성 및 종합 의견");
    expect(style("record")).toContain("~함");
  });

  it("couple 지시: 방·참여자 수, 구성 4개를 CONCEPTS 순서로, 분량 상한", () => {
    const body = instructionOf(buildRequest(payload("couple")));
    expect(body).toContain("방: 1:1 · 참여자 2명(<members>의 범례)");
    expect(body).toContain("letter 「두 사람에게 쓰는 편지」");
    const at = CONCEPTS.couple.parts.map((part) => body.indexOf(`- ${part.key} 「${part.title}」: `));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(body).toContain(
      "분량: 구성마다 섹션 1~2개, 리포트 전체 섹션 8개 이하, 섹션마다 문단 2~3개. 근거 인용은 리포트 전체 16개 이하. reading_notes는 12개 이하.",
    );
    // 편지는 둘 모두에게 쓰고 한쪽 편을 들지 않는다
    expect(body).toMatch(/letter 「두 사람에게 쓰는 편지」: [^\n]*둘 모두에게[^\n]*한쪽 편을 들지 않/);
    // 편지도 방 밖의 관찰자가 건넨다('우리'로 방에 끼지 않는다)
    expect(body).toMatch(/letter 「두 사람에게 쓰는 편지」: [^\n]*방 밖의 관찰자[^\n]*'우리'로 쓰지 않/);
    expect(body).not.toContain("철수");
    expect(body).not.toContain("민지");
  });

  it("group 지시: characters는 상위 6명을 한 사람에 한 문단씩", () => {
    const body = instructionOf(buildRequest(payload("group")));
    expect(body).toContain("방: 단톡방 · 참여자 2명(<members>의 범례)");
    expect(body).toMatch(/- characters 「멤버 캐릭터 카드」: 섹션 1~2개[^\n]*상위 6명을 한 사람에 한 문단씩/);
  });

  it("전부 보낸 대화는 '대화 전체 N개', 일부만 보냈으면 전체 중 몇 개를 고르게 골랐다고 알린다", () => {
    const p = payload();
    expect(p.anchors).toBe("");
    expect(instructionOf(buildRequest(p))).toContain(`기간: ${p.period.start}~${p.period.end}. 대화 전체 ${p.msgTotal}개를 보냈다.`);
    const big = bigPayload();
    expect(big.anchors).toBe("");
    const body = instructionOf(buildRequest(big));
    expect(body).not.toContain("대화 전체");
    expect(body).toContain(`전체 ${big.msgTotal}개 중 ${big.msgSent}개를 처음부터 끝까지 고르게 골라 보냈다.`);
    // 예전 사본(anchors + 최근 구간)은 예전 문구
    const old = instructionOf(buildRequest({ ...big, anchors: "# 2021-01-01\nm0|09:00|A|첫" }));
    expect(old).toContain(`전체 ${big.msgTotal}개 중 최근 ${big.msgSent}개와 발췌를 보냈다.`);
  });

  it("system의 데이터 계약: <conversation>은 전체 기간에서 고른 시간순 메시지다", () => {
    const system = systemOf(buildRequest(payload()));
    expect(system).toContain("처음부터 끝까지 전체 기간에서 고르게 골랐다");
    expect(system).toContain("가장 활발했던 날들");
    expect(system).toContain("최근 구간을 조금 더");
    expect(system).not.toContain("마지막 메시지까지 이어지는 최근 구간이다");
  });

  it("messages[0]: members·stats·conversation 한 블록, 예전 사본이면 anchors도", () => {
    const p = payload();
    const first = buildRequest(p).messages[0];
    expect(first.role).toBe("user");
    expect(first.content).toEqual([
      {
        type: "text",
        text: `<members>${legendText(p.members)}</members><stats>${JSON.stringify(statsForPrompt(p.stats))}</stats><conversation>${p.transcript}</conversation>`,
      },
    ]);
    const anchors = "# 2026-10-01\nm0|20:00|A|오늘 뭐해?";
    expect(text(buildRequest({ ...p, anchors }).messages[0].content)).toContain(`</stats><anchors>${anchors}</anchors><conversation>`);
  });

  it("40명 × 60개월: 데이터 블록의 stats는 요약(사람 12명, 최근 24개월)이고 지시가 그 사실을 알린다", () => {
    const p = bigPayload();
    const req = buildRequest(p);
    const stats = JSON.parse(/<stats>(.*?)<\/stats>/.exec(text(req.messages[0].content))![1]);
    expect(stats).not.toHaveProperty("dailyCounts");
    expect(Object.keys(stats.byPerson).length).toBeLessThanOrEqual(PROMPT_STATS_MAX_PEOPLE);
    expect(Object.keys(stats.monthly)).toHaveLength(PROMPT_STATS_MAX_MONTHS);
    expect(stats.omitted).toEqual({ people: 28, months: 36 });
    // 페이로드에는 전체 stats가 그대로 남는다(서버의 자리표시자 해석용)
    expect(Object.keys(p.stats.byPerson)).toHaveLength(40);
    const body = instructionOf(req);
    expect(body).toContain("통계에는 메시지가 많은 12명만 있다");
    expect(body).toContain("stats.monthly에는 최근 24개월만 있다");
  });

  it("사람·달을 뺀 것이 없으면 지시에 요약 안내가 없다", () => {
    const body = instructionOf(buildRequest(payload()));
    expect(body).not.toContain("명만 있다");
    expect(body).not.toContain("개월만 있다");
  });

  it("크기: system + 가장 긴 지시가 PROMPT_RESERVE_TOKENS 안에 든다", () => {
    const reqs = TONE_KEYS.flatMap((t) => [buildRequest(payload("couple", t)), buildRequest(payload("group", t)), buildRequest(bigPayload(t))]);
    const longest = Math.max(...reqs.map((r) => instructionOf(r).length));
    expect((systemOf(reqs[0]).length + longest) * TOKENS_PER_CHAR).toBeLessThanOrEqual(PROMPT_RESERVE_TOKENS);
  });

  it("지시 자리: system이면 messages 2개(마지막이 role system), user면 messages 1개에 글 블록 2개(데이터 뒤)", () => {
    const asSystem = requestMessages("DATA", "지시", "system");
    expect(asSystem).toEqual([
      { role: "user", content: [{ type: "text", text: "DATA" }] },
      { role: "system", content: "지시" },
    ]);
    const asUser = requestMessages("DATA", "지시", "user");
    expect(asUser).toHaveLength(1);
    expect(asUser[0].role).toBe("user");
    expect(asUser[0].content).toEqual([
      { type: "text", text: "DATA" },
      { type: "text", text: "지시" },
    ]);
  });

  it("output_config.format: parse 함수가 없고 스키마 속성 순서가 고정이다", () => {
    const format = buildRequest(payload()).output_config?.format;
    expect(format?.type).toBe("json_schema");
    expect(format).not.toHaveProperty("parse");
    const schema = format?.schema as {
      properties: Record<string, { items?: { properties: Record<string, { items?: { properties: object } }> } }>;
      required: string[];
    };
    const top = ["safety", "declined_topics", "reading_notes", "headline", "dek", "sections"];
    expect(Object.keys(schema.properties)).toEqual(top);
    expect(schema.required).toEqual(top);
    const section = schema.properties.sections.items!.properties;
    expect(Object.keys(section)).toEqual(["part", "icon", "title", "about", "paragraphs", "evidence"]);
    expect(Object.keys(section.paragraphs.items!.properties)).toEqual(["key", "text", "evidence_ids"]);
    expect(Object.keys(section.evidence.items!.properties)).toEqual(["id", "msg_id", "quote"]);
    expect(Object.keys(schema.properties.reading_notes.items!.properties)).toEqual(["range", "note"]);
  });
});
