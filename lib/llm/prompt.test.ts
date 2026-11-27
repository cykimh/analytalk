import { describe, expect, it } from "vitest";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages";
import { EPISODE_DEADLINE_MS, MAX_QUOTES_PER_REPORT, PROMPT_RESERVE_TOKENS, PROMPT_STATS_MAX_MONTHS, PROMPT_STATS_MAX_PEOPLE, TOKENS_PER_CHAR } from "@/lib/config";
import type { ChatMessage } from "@/lib/parse/parse";
import { buildPayload, legendText, type Payload } from "@/lib/payload/build";
import { STAT_PATHS } from "@/lib/stats/paths";
import { statsForPrompt } from "@/lib/stats/view";
import { syntheticGroupChat } from "@/test/syntheticChat";
import { CONCEPTS, DEFAULT_TONE, PICKABLE_TONES, type PickableTone, TONE_KEYS, TONES, type Tone } from "./concepts";
import { memberCodes } from "@/lib/payload/build";
import {
  buildRequests,
  type CallPart,
  countRequest,
  DEADLINE_ESTIMATE,
  PARAGRAPH_MAX,
  PARAGRAPH_MIN,
  PEOPLE_CAP,
  PEOPLE_SPLIT_FROM,
  PROMPT_VERSION,
  peopleOrder,
  peopleShape,
  quoteShares,
  reportParts,
  requestMessages,
  speakerCount,
  VOLUME_FULL_FROM,
  VOLUME_SMALL_BELOW,
  VOLUMES,
  volumeTier,
} from "./prompt";
import { DEFAULT_REPORT_MAX_TOKENS, modelSettings } from "./settings";

/** KST 벽시계 → UTC epoch ms */
const kst = (d: number, h: number, mi: number) => Date.UTC(2026, 9, d, h, mi) - 9 * 3_600_000;

/** 철수·민지의 days일 대화(기본 사흘, 하루 2개). 예산이 넉넉해 전부 보낸다 */
function payload(concept: Payload["concept"] = "couple", tone: PickableTone = "fact", days = 3): Payload {
  const rows: [string, number, string][] = [];
  for (let d = 1; d <= days; d++) {
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
/** 첫 호출(①)의 요청. system·데이터 블록·말투 줄 같은 호출끼리 같은 부분을 볼 때 쓴다 */
const buildRequest = (p: Payload, s?: Parameters<typeof buildRequests>[1]) => buildRequests(p, s)[0].req;
/** 그 몫 호출의 지시 */
const ins = (p: Payload, part: CallPart) => instructionOf(buildRequests(p).find((c) => c.part === part)!.req);
/** 리포트의 모든 호출 지시 */
const allIns = (p: Payload) => buildRequests(p).map((c) => instructionOf(c.req));
/** 범례 기호 목록 */
const codesOf = (p: Payload, names: string[]) => names.map((n) => memberCodes(p.members)[p.members.indexOf(n)]).join(", ");

/** 40명 × 60개월 단톡: 예산이 작아 전체 기간에서 골라 보낸다(v2.7: 혼자 보낸 사진·이모티콘을 빼고 649개, medium 분량) */
const bigPayload = (tone: PickableTone = "fact") =>
  buildPayload({ messages: syntheticGroupChat(40, 60), tone, concept: "group", kind: "group", tokenBudget: 20_000, tokensPerChar: 1 });
/** 같은 40명 단톡을 예산을 키워 6,641개 보낸다(full 분량) */
const hugePayload = (tone: PickableTone = "fact") =>
  buildPayload({ messages: syntheticGroupChat(40, 60), tone, concept: "group", kind: "group", tokenBudget: 200_000, tokensPerChar: 1 });
/** 1:1 800일 = 1,600개(full 분량) */
const longPair = (tone: PickableTone = "fact") => payload("couple", tone, 800);

describe("CONCEPTS·TONES", () => {
  it("컨셉 제목 2개, 고를 수 있는 제3자 말투 5개(v2.3: 상담 선생님·생활기록부를 담임 선생님으로 합침, 기본 fact)", () => {
    expect(CONCEPTS.group.title).toBe("친구·가족 단톡방");
    expect(CONCEPTS.couple.title).toBe("연애·썸");
    expect(PICKABLE_TONES).toEqual(["fact", "warm", "show", "docu", "detective"]);
    expect(PICKABLE_TONES.map((t) => TONES[t].label)).toEqual(["잔소리하는 친구", "담임 선생님", "예능 MC 중계", "자연 다큐 내레이터", "탐정 사건 보고서"]);
    expect(DEFAULT_TONE).toBe("fact");
    // 저장된 행이 가질 수 있는 키는 6개 그대로(DB check·최근 목록). 예전 record 리포트도 '담임 선생님'으로 보인다
    expect(TONE_KEYS).toEqual(["fact", "warm", "show", "docu", "detective", "record"]);
    expect(TONES.record.label).toBe("담임 선생님");
  });

  it("v2.4: 모든 말투가 인트로 종합 → 개인별(people·others) → 마무리 뼈대다. 키는 말투끼리 겹치지 않는다", () => {
    const titles = (t: Tone) => TONES[t].parts.map((p) => p.title);
    expect(titles("fact")).toEqual(["첫 잔소리", "이 방 전체에 하는 잔소리", "사람별 잔소리 카드", "그 밖의 멤버 한 줄 잔소리", "마지막 한마디"]);
    expect(titles("warm")).toEqual(["학급 개요", "이 반의 좋은 습관", "학생별 종합 의견", "그 밖의 학생들", "서로에게 건네는 조언", "담임의 편지"]);
    expect(titles("show")).toEqual(["오프닝", "하이라이트 VCR", "출연자 소개", "그 밖의 출연자", "이 방 시상식", "클로징"]);
    expect(titles("docu")).toEqual(["서식지", "계절의 변화", "개체별 관찰", "그 밖의 개체들", "결정적 장면", "내레이션 마무리"]);
    expect(titles("detective")).toEqual(["사건 개요", "사건 재구성", "관련자 프로필", "그 밖의 관련자", "미해결 의문", "수사 결론"]);
    // 예전 warm 행과 이어지게 키(care_*)는 그대로
    expect(TONES.warm.parts.map((p) => p.key)).toEqual(["care_open", "care_habits", "care_people", "care_others", "care_advice", "care_letter"]);
    // 예전 record 행 전용 구성(고를 수 없다)
    expect(titles("record")).toEqual(["학급 개요", "학생별 행동 특성 및 종합 의견", "출결·참여 특기사항", "담임 총평"]);
    const order = ["intro", "people", "others", "outro"];
    for (const t of PICKABLE_TONES) {
      const stages = TONES[t].parts.map((p) => p.stage);
      // 자리 순서를 지키고, 인트로·마무리는 1~2개, 개인별·그 밖의 멤버는 하나씩
      expect(stages).toEqual([...stages].sort((x, y) => order.indexOf(x) - order.indexOf(y)));
      for (const [stage, lo, hi] of [["intro", 1, 2], ["people", 1, 1], ["others", 1, 1], ["outro", 1, 2]] as const) {
        const n = stages.filter((x) => x === stage).length;
        expect(n, `${t} ${stage}`).toBeGreaterThanOrEqual(lo);
        expect(n, `${t} ${stage}`).toBeLessThanOrEqual(hi);
      }
    }
    const keys = TONE_KEYS.flatMap((t) => TONES[t].parts.map((p) => p.key));
    expect(new Set(keys).size).toBe(keys.length);
    // 예전 컨셉 구성 키(chronicle·letter…)와 v2.3까지의 증거물 목록은 어느 말투에도 없다
    for (const old of ["chronicle", "characters", "scenes", "rhythm", "map", "first", "shift", "letter", "case_exhibits"]) expect(keys).not.toContain(old);
  });

  it("개인별 섹션 수: 말한 사람 중 메시지 많은 순 상위 6명, 그다음 순위는 많아야 6명을 others 섹션에서 한 문단씩", () => {
    expect(PEOPLE_CAP).toBe(6);
    expect(peopleShape(payload())).toEqual({ persons: 2, others: 0 });
    expect(peopleShape(hugePayload())).toEqual({ persons: 6, others: 6 });
    const eight = buildPayload({ messages: syntheticGroupChat(8, 60), tone: "show", concept: "group", kind: "group", tokenBudget: 200_000, tokensPerChar: 1 });
    expect(peopleShape(eight)).toEqual({ persons: 6, others: 2 });
    const three = buildPayload({ messages: syntheticGroupChat(3, 2), tone: "warm", concept: "group", kind: "group", tokenBudget: 1_000_000, tokensPerChar: 1 });
    expect(peopleShape(three)).toEqual({ persons: 3, others: 0 });
    // others 구성은 그다음 순위가 있을 때만, small은 인트로·마무리를 하나씩(첫 intro·마지막 outro)
    expect(reportParts(eight).others?.key).toBe("show_others");
    // v2.5: 사람은 메시지 많은 순(statsForPrompt와 같은 순서)이고 말한 사람만
    const order = peopleOrder(eight);
    const counts = order.persons.map((i) => eight.stats.byPerson[eight.members[i]]);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    expect(order.others).toHaveLength(2);
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(Math.max(...order.others.map((i) => eight.stats.byPerson[eight.members[i]])));
    expect(reportParts(three).others).toBeUndefined();
    const small = reportParts(payload("couple", "show"));
    expect([small.intro.map((p) => p.key), small.outro.map((p) => p.key)]).toEqual([["show_open"], ["show_close"]]);
    const full = reportParts(hugePayload("show"));
    expect([full.intro.map((p) => p.key), full.people.key, full.outro.map((p) => p.key)]).toEqual([["show_open", "show_vcr"], "show_cast", ["show_corner", "show_close"]]);
  });
});

describe("buildRequest", () => {
  it("PROMPT_VERSION", () => {
    expect(PROMPT_VERSION).toBe("2026-11-report-12");
  });

  it("기본값(호출마다): Sonnet 5.5, max_tokens 32000, effort medium, adaptive thinking, 서버 측 fallback, 데이터 블록에 cache_control(ephemeral)", () => {
    for (const { req: r } of buildRequests(payload())) {
      expect(r.model).toBe("claude-sonnet-5-5");
      expect(r.max_tokens).toBe(32_000);
      expect(r.output_config?.effort).toBe("medium");
      expect(r.thinking).toEqual({ type: "adaptive" });
      expect(r.betas).toEqual(["server-side-fallback-2026-07-01"]);
      expect(r.fallbacks).toBe("default");
      // v2.5: 데이터 블록에 캐시 지점(①이 쓰고 ②·③이 읽는다). 지시(마지막 system 메시지)에는 없다
      const first = r.messages[0].content as { cache_control?: unknown }[];
      expect(first).toHaveLength(1);
      expect(first[0].cache_control).toEqual({ type: "ephemeral" });
      expect(JSON.stringify(r.messages[1])).not.toContain("cache_control");
      // forced tool_choice·Citations·자동 캐시(최상위 cache_control)는 쓰지 않는다
      expect(r).not.toHaveProperty("tool_choice");
      expect(r).not.toHaveProperty("tools");
      expect(r).not.toHaveProperty("cache_control");
      expect(r).not.toHaveProperty("stream");
    }
  });

  it("모델 설정을 인자로 받는다: model·effort·max_tokens(호출마다 같다)", () => {
    const s = modelSettings({ ANTHROPIC_MODEL: "claude-opus-5-5", ANTHROPIC_EFFORT: "low", REPORT_MAX_TOKENS: "9000" });
    for (const { req: r } of buildRequests(payload(), s)) {
      expect(r.model).toBe("claude-opus-5-5");
      expect(r.output_config?.effort).toBe("low");
      expect(r.max_tokens).toBe(9000);
    }
  });

  it("v2.5 나눠 쓰기: 1:1·사람 3명 이하는 ①인트로 ②개인별 ③마무리, 4명 이상이면 개인별을 상위 3명 / 나머지 + 그 밖의 멤버로 나눈다", () => {
    expect(PEOPLE_SPLIT_FROM).toBe(4);
    expect(buildRequests(payload()).map((c) => c.part)).toEqual(["intro", "people", "outro"]);
    expect(buildRequests(longPair()).map((c) => c.part)).toEqual(["intro", "people", "outro"]);
    const three = buildPayload({ messages: syntheticGroupChat(3, 2), tone: "warm", concept: "group", kind: "group", tokenBudget: 1_000_000, tokensPerChar: 1 });
    expect(buildRequests(three).map((c) => c.part)).toEqual(["intro", "people", "outro"]);
    const eight = buildPayload({ messages: syntheticGroupChat(8, 60), tone: "show", concept: "group", kind: "group", tokenBudget: 200_000, tokensPerChar: 1 });
    const calls = buildRequests(eight);
    expect(calls.map((c) => c.part)).toEqual(["intro", "people", "people_rest", "outro"]);
    expect(calls.map((c) => c.stages)).toEqual([["intro"], ["people", "others"], ["people", "others"], ["outro"]]);
    const order = peopleOrder(eight);
    const names = (who: number[]) => who.map((i) => eight.members[i]);
    expect(calls[1].people).toEqual(names(order.persons.slice(0, 3)));
    expect(calls[2].people).toEqual(names(order.persons.slice(3)));
    // 호출마다 자기 사람을 범례 기호로 받는다(지시에 실명을 싣지 않는다)
    const [, a, b] = calls.map((c) => instructionOf(c.req));
    expect(a).toContain(`show_cast 「출연자 소개」에서 기호 ${codesOf(eight, calls[1].people)} 각자 섹션 하나씩. 나머지 사람은 다른 응답이 쓴다.`);
    expect(b).toContain(`show_cast 「출연자 소개」에서 기호 ${codesOf(eight, calls[2].people)} 각자 섹션 하나씩, 그리고 show_others 「그 밖의 출연자」 섹션 하나.`);
    expect(a).not.toContain("- show_others ");
    expect(b).toContain(`- show_others 「그 밖의 출연자」: 섹션 하나, about은 group, 기호 ${codesOf(eight, names(order.others))} 2명을 한 사람에 문단 하나씩(문단 2개). `);
    for (const body of [a, b]) for (const name of eight.members) expect(body).not.toContain(name);
  });

  it("v2.5: 한 리포트의 호출끼리 system·데이터 블록·모델·thinking·output_config·betas가 바이트 단위로 같고 마지막 지시만 다르다(캐시 앞부분)", () => {
    for (const p of [payload(), hugePayload("docu"), longPair("show")]) {
      const reqs = buildRequests(p).map((c) => c.req);
      const prefix = (r: BetaMessageStreamParams) =>
        JSON.stringify({ system: r.system, first: r.messages[0], model: r.model, thinking: r.thinking, output_config: r.output_config, betas: r.betas, fallbacks: r.fallbacks });
      for (const r of reqs) {
        expect(prefix(r)).toBe(prefix(reqs[0]));
        expect(r.messages).toHaveLength(2);
        expect(r.messages[1].role).toBe("system");
      }
      expect(new Set(reqs.map((r) => instructionOf(r))).size).toBe(reqs.length);
    }
  });

  it("v2.5: 이번 응답의 몫은 지시 마지막 줄이다. headline·dek·reading_notes는 ①만 쓰고 나머지는 비워 둔다", () => {
    const p = hugePayload("fact");
    const last = (part: CallPart) => ins(p, part).split("\n").at(-1)!;
    expect(last("intro")).toBe(
      "이번 응답: [1. 인트로 종합 리포트]의 섹션 2개(nag_open, nag_room)만 쓴다. 개인별·마무리 섹션은 쓰지 않는다. 인트로는 방 전체의 장면·습관·흐름을 쓰고, 한 사람을 깊게 다루는 이야기는 개인별 응답에 남긴다. headline·dek와 reading_notes(12개 이하), chemistry(케미 온도)도 이 응답이 쓴다.",
    );
    for (const part of ["people", "people_rest", "outro"] as const) {
      expect(last(part)).toContain('headline·dek는 빈 글(""), reading_notes는 빈 배열, chemistry는 null로 둔다.');
    }
    expect(last("outro")).toContain("이번 응답: [3. 마무리 리포트]의 섹션 1개(nag_last)만 쓴다. 인트로·개인별 섹션은 쓰지 않는다.");
    // 다른 몫의 구성은 이름만 보이고 구성 줄은 없다
    expect(ins(p, "intro")).toContain("  (다른 응답이 쓴다: nag_cards 「사람별 잔소리 카드」, nag_others 「그 밖의 멤버 한 줄 잔소리」)");
    expect(ins(p, "intro")).not.toContain("- nag_cards ");
    expect(ins(p, "outro")).toContain("  (다른 응답이 쓴다: nag_open 「첫 잔소리」, nag_room 「이 방 전체에 하는 잔소리」)");
    expect(ins(p, "people")).not.toContain("- nag_last ");
  });

  it("v2.5: 근거 인용 몫은 섹션 수에 비례해 호출마다 나누고 합은 리포트 전체 목표 이하다", () => {
    expect(quoteShares([2, 3, 4, 2], VOLUMES.full)).toEqual([5, 8, 10, 6]);
    expect(quoteShares([1, 2, 1], VOLUMES.small)).toEqual([2, 4, 2]);
    for (const make of [payload, bigPayload, hugePayload, longPair] as const) {
      const p = make("fact" as never);
      const shares = allIns(p).map((body) => Number(/이번 응답 전체 (\d+)개 이하/.exec(body)![1]));
      expect(shares.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(VOLUMES[volumeTier(p.msgSent)].quotes);
      expect(shares.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(MAX_QUOTES_PER_REPORT);
    }
  });

  it("countRequest: 입력 토큰을 셀 요청은 지시가 가장 긴 호출이다", () => {
    const p = hugePayload("warm");
    const longest = Math.max(...allIns(p).map((b) => b.length));
    expect(instructionOf(countRequest(p)).length).toBe(longest);
  });

  it("말투 5종 요청은 system·messages[0]이 같고 마지막 지시만 다르다. 지시는 말투 라벨로 시작한다", () => {
    const reqs = PICKABLE_TONES.map((t) => buildRequest(payload("couple", t)));
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
    expect(new Set(reqs.map((r) => JSON.stringify(r.messages[1]))).size).toBe(5);
    expect(reqs[0].messages[1].role).toBe("system");
    PICKABLE_TONES.forEach((t, i) => expect(instructionOf(reqs[i]).startsWith(`말투: ${TONES[t].label}\n`)).toBe(true));
  });

  it("system과 다섯 지시 어디에도 업로더에게 넘기는 말·없어진 가림 표시가 없다", () => {
    const all = [systemOf(buildRequest(payload())), ...[...PICKABLE_TONES.map((t) => payload("couple", t)), payload("group")].flatMap(allIns)];
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
    // v2.2: 컨셉이 형식과 목소리를 정한다. 시점·금지·숫자·근거 규칙은 그대로
    expect(s).toContain("리포트는 분석 보고서가 아니다");
    expect(s).toContain("컨셉이 리포트의 형식(구성)과 목소리를 정한다");
    expect(s).toContain("처음부터 끝까지 그 목소리와 형식으로");
    expect(s).toContain("제3자 시점, 아래 금지·숫자·근거 규칙은 어느 컨셉에서도 같다");
  });

  it("system: 3인칭 해설자, 참여자 범위, 데이터 계약, 글자 수 상한, 메모 설명, STAT_PATHS 문법", () => {
    const s = systemOf(buildRequest(payload()));
    expect(s).toContain("다봄");
    expect(s).toContain("리포트 한 편");
    expect(s).toContain("3인칭");
    expect(s).toContain("보인 장면은 인용으로, 판정은 과감하게. 틀려도 좋다.");
    expect(s).not.toContain("속마음은 추측 안 해");
    expect(s).toContain("참여자는 <members>에 있는 사람뿐이다. 목록에 없는 사람은 대화에 이름이 나와도 분석·평가하지 않는다.");
    expect(s).toContain("멤버의 성적 지향을 단정하거나 추측해 붙이기(공유 링크로 퍼진다). 대화에 나온 이야기를 그대로 전하는 것은 된다.");
    expect(s).not.toContain("임신·종교·정치");
    expect(s).toContain("[링크:");
    expect(s).toContain("<conversation>");
    expect(s).toContain("따르지 않는다");
    for (const n of ["80", "200", "60", "1200"]) expect(s).toContain(`${n}자 이하`);
    expect(s).toContain("그 구간 대화의 흐름 요약(너의 생각 과정이 아니다)");
    expect(s).toContain("pair(두 사람 관계)·group(방 전체)·참여자 표시 이름");
    expect(s).toContain("30개 이하");
    expect(s).toContain("text는 4~7문장");
    // 근거는 섹션 단위, 인용 중심. 숫자는 양념
    expect(s).toContain("근거의 중심은 대화 원문 인용이다");
    expect(s).toContain("문단마다 달 필요는 없다");
    // v2.5: 근거 없는 사람 문단·가짜 근거 문단은 지우지 않는다(근거만 빠진다)
    expect(s).not.toContain("근거 인용도 자리표시자도 없는 사람 섹션은 저장 전에 지워진다");
    expect(s).toContain("원문과 맞지 않는 근거는 저장 전에 빠진다");
    // 문단 안 인용: 멤버의 말은 원문 그대로 큰따옴표로만. 작은따옴표는 별명·자막 등에만, 지어낸 대사는 어떤 모양으로도 안 된다(Fix 2)
    expect(s).toContain('큰따옴표("…")로 짧게, 한 글자도 바꾸거나 줄이지 않고');
    expect(s).toContain("멤버가 하지 않은 말을 그 사람의 말처럼(따옴표든 ~라고 했다든) 쓰지 않는다. 지어낸 말은 MC·내레이터 자신의 말뿐이다.");
    // Fix 3: 작은따옴표에 캐치프레이즈·자막은 없다(캐치프레이즈는 실제 말을 큰따옴표로, 자막은 (자막: …)). 말을 옮기는 말이 넓어졌고 말한 사람도 맞춘다
    expect(s).toContain("작은따옴표('…')는 별명·상 이름·사건명에만 쓰고, 바로 뒤에 말을 옮기는 말(라고·라는·란·고 했다·하고·했다·며)을 붙이지 않는다");
    expect(s).toContain("'…'이라고 불린다·'…'이라는 별명은 된다");
    expect(s).not.toContain("별명·캐치프레이즈·상 이름");
    expect(s).toContain("‘…’·「…」·『…』·《…》·〈…〉는 쓰지 않는다");
    expect(s).toContain("원문에 없는 인용(부호 안의 말, 말을 옮기는 말이 뒤에 붙은 '…'), 그 말을 안 보낸 멤버 이름과 한 문장에 둔 인용은 저장 전에 따옴표가 떼어진다");
    expect(s).not.toContain("지어낸 대사는 작은따옴표");
    expect(s).toContain("text는 4~7문장, 250~400자(적어도 250자. 1200자 이하, 넘으면 지워진다)");
    expect(s).toContain("숫자는 양념이다");
    expect(s).not.toContain("사람에 관한 문단에는 근거 인용이나 자리표시자를 반드시 단다");
    expect(s).not.toContain("teaser");
    expect(s).not.toContain("episode");
    expect(s).toContain("{{stat:");
    for (const path of STAT_PATHS) expect(s).toContain(path);
    // 화면이 단위를 붙인다: 자리표시자 뒤에 단위를 쓰지 않게 알려 준다
    expect(s).toContain("단위");
    expect(s).toContain("67%");
  });

  it("v2.8: 케미 온도(chemistry)는 0~100 정수 점수 + 한 줄이고 null도 된다. 스키마에 범위·모양 제약은 없다(검증이 본다)", () => {
    type Obj = { type?: string; properties?: Record<string, Obj>; required?: string[]; anyOf?: Obj[]; $ref?: string; description?: string };
    const schema = buildRequest(payload()).output_config?.format?.schema as Obj & { $defs?: Record<string, Obj> };
    const chemistry = schema.properties!.chemistry;
    expect(chemistry.anyOf).toHaveLength(2);
    expect(chemistry.anyOf![1]).toEqual({ type: "null" });
    const ref = chemistry.anyOf![0].$ref ?? "";
    const def = ref.startsWith("#/$defs/") ? schema.$defs![ref.slice("#/$defs/".length)] : chemistry.anyOf![0];
    expect(Object.keys(def.properties!)).toEqual(["score", "line"]);
    expect(def.required).toEqual(["score", "line"]);
    expect(def.properties!.score.type).toBe("number");
    expect(def.properties!.line.type).toBe("string");
    // 범위·모양 제약(SDK가 설명 글로 바꾸는 min/max 포함)은 없다
    expect(JSON.stringify(def)).not.toMatch(/minimum|maximum|pattern|9007199254740991/);
    expect(JSON.stringify(schema.properties!.sections)).not.toMatch(/pattern|minimum/);
  });

  it("v2.8: system이 케미 온도·MBTI를 알리고, 인트로만 chemistry를, 개인별만 사람 섹션의 mbti를 쓴다", () => {
    const s = systemOf(buildRequest(payload()));
    expect(s).toContain("- chemistry: 이 방(1:1이면 두 사람)의 케미 온도. score는 컨셉 인물이 0~100 정수로 매긴 점수");
    expect(s).toContain("지시가 맡긴 응답만 쓰고 맡지 않은 응답은 null");
    expect(s).toContain("  - mbti·mbti_reason: about이 참여자인 개인별 섹션에만 쓴다.");
    expect(s).toContain("E/I·N/S·T/F·J/P, 예: ENFP");
    expect(s).toContain('그 밖의 섹션은 둘 다 빈 글("")');
    for (const p of [payload(), hugePayload("show"), longPair("detective")]) {
      const calls = buildRequests(p);
      for (const c of calls) {
        const last = instructionOf(c.req).split("\n").at(-1)!;
        if (c.part === "intro") expect(last).toContain("chemistry(케미 온도)도 이 응답이 쓴다.");
        else expect(last).toContain("chemistry는 null로 둔다.");
        if (c.part === "people" || c.part === "people_rest") expect(last).toContain("사람마다 그 섹션의 mbti·mbti_reason에 그 사람의 MBTI 추측과 이유를 쓴다");
        else expect(last).not.toContain("mbti");
      }
    }
  });

  it("system(v2.4 Fix 1·v2.5): 관점과 판정. 속마음·호감·점수·놀림·욕·진단명 꼬리표까지 인물의 판단으로(틀려도 좋다), 금지는 넷뿐", () => {
    const s = systemOf(buildRequest(payload()));
    expect(s).toContain("## 관점과 판정");
    expect(s).toContain("사실을 늘어놓고 설명하는 데서 멈추지 않는다");
    for (const kind of ["별명 붙이기", "순위·시상", "판결(\"범인은 <이름>이다\")", "과장된 비유", "단정적인 역할 규정(\"이 방의 실세는 <이름>이다\")", "엉뚱한 가설"]) {
      expect(s).toContain(kind);
    }
    expect(s).toContain("판정은 틀려도 괜찮다");
    expect(s).toContain("재미 포인트");
    // 2026-11-27 사용자 "3번에서 막던 건 막지 말자": 속마음·호감·연애 감정, 점수·순위, 놀림·디스·별명, 친구끼리 욕도 된다
    expect(s).toContain("판정할 것에 제한을 두지 않는다");
    expect(s).toContain("탐정의 결론: <이름>은 <이름>을 좋아한다. 증거는 부족하지만 감은 확실하다");
    // v2.8: MBTI 추측은 금지 목록이 아니라 출력 항목이다(2026-11-27 사용자 승인). 금지 목록에는 없다
    expect(s.split("## 금지 (이 넷만 막는다)\n")[1].split("\n이런 표현이")[0]).not.toContain("MBTI");
    for (const ok of ["호감·케미 점수와 순위", "성격 유형·진단명 같은 꼬리표", "외모 놀림", "친구끼리 웃자고 하는 놀림·디스·별명", "친구끼리 쓰는 정도의 욕까지 된다", "속마음·호감·연애 감정·의도까지 인물의 관점에서 추측하거나 단정해도 된다(틀려도 좋다)"]) {
      expect(s).toContain(ok);
    }
    expect(s).toContain("따옴표에 넣지 않는다: 따옴표 안은 실제로 오간 말뿐이다");
    for (const gone of ["누구의 속마음·의도·감정도 단정하거나 추측하지 않는다", "누구의 속마음 단정·추측", "애정·관심·호감 점수", "외모 평가, 비속어, 모욕"]) {
      expect(s).not.toContain(gone);
    }
    // v2.5: 계속 막는 넷(R28): 혐오·차별, 자해·폭력 부추김, 멤버에 대한 성적 묘사, 멤버의 성적 지향 단정
    expect(s).toContain("## 금지 (이 넷만 막는다)");
    const bans = s.split("## 금지 (이 넷만 막는다)\n")[1].split("\n이런 표현이")[0].split("\n");
    expect(bans).toHaveLength(4);
    for (const [i, rule] of ["- 혐오·차별: 성별·출신 지역·인종·국적·장애·성적 지향", "- 자해·폭력을 부추기는 말", "- 멤버에 대한 성적인 묘사", "- 멤버의 성적 지향을 단정하거나 추측해 붙이기"].entries()) {
      expect(bans[i].startsWith(rule), rule).toBe(true);
    }
    for (const gone of ["진단명을 사실처럼 붙이기", "- 지어낸 대사:", "- 퍼센트를 글자로 쓰기"]) expect(s).not.toContain(gone);
    // %는 금지 목록이 아니라 숫자 규칙에 있다
    expect(s).toContain("퍼센트(%)를 글자로 쓴 문단은 저장 전에 지워진다");
    expect(s).toContain("멤버가 하지 않은 말을 그 사람의 말처럼");
    // v2.5: 응답 여러 개가 나눠 쓰고 화면이 붙인다. 응답마다 맡은 구성만
    expect(s).toContain("리포트 한 편은 응답 여러 개가 같은 대화를 보고 나눠 쓰고, 화면이 인트로 종합 → 개인별 → 마무리 순서로 붙인다.");
    expect(s).toContain("sections: 지시가 이번 응답에 맡긴 구성만, 지시의 순서대로 쓴다. 다른 응답이 맡은 구성의 섹션은 쓰지 않는다.");
    expect(s).toContain("이번 응답에서는 지시의 개수 이하(리포트 전체 30개 이하)");
  });

  it("말투 지시: 라벨 다음 한 줄에 그 컨셉의 인물(persona)·판정(judge)과 문단 하나 길이의 예시 1~2개, 공통 가드레일", () => {
    const style = (t: PickableTone) => instructionOf(buildRequest(payload("couple", t))).split("\n")[1];
    for (const t of PICKABLE_TONES) {
      const line = style(t);
      expect(line.startsWith(`${TONES[t].label}.`)).toBe(true);
      expect(line).toContain("예: \"");
      expect(line).toContain("절반·두 배처럼 숫자를 말로 대신 쓰지 않는다");
      // 어느 말투든 제3자 관찰자·실명 3인칭·보이는 행동만, 행동에는 과감한 판정(틀려도 된다), 이용 정책 금지
      expect(line).toContain("방 밖의 관찰자로 실명 3인칭");
      expect(line).toContain("보인 장면을 근거로 그 인물의 관점에서 과감하게 판정한다");
      for (const ok of ["속마음·호감·연애 감정 추측", "호감·케미 점수와 순위", "성격 유형·진단명 꼬리표", "놀림·별명·욕도 된다(틀려도 좋다)"]) expect(line).toContain(ok);
      for (const rule of ["따옴표 없이 인물의 말로", "멤버가 안 한 말을 그 사람 말처럼 쓰지 않는다", "혐오·차별, 자해·폭력 부추김, 성적 묘사, 성적 지향 단정은 쓰지 않는다"]) expect(line).toContain(rule);
      expect(line).not.toContain("진단명 단정");
      expect(line).not.toContain("모욕");
      // v2.4: 말투마다 그 인물의 판정 모양이 있다
      expect(line).toContain(" 판정: ");
      expect(line).toMatch(/틀려도/);
      // 인물 설명이 넉넉하다(한 문단짜리 문체 지시가 아니다)
      expect(line.split("예: ")[0].length).toBeGreaterThan(200);
      // 예시: 1~2개, 실명 자리(<이름>)로 3인칭, 글자로 쓴 숫자 없음, 자리표시자는 예시 하나에 많아야 하나
      const examples = line.split("예: ")[1].split(" 어느 말투든")[0].split(" / ");
      expect(examples.length).toBeGreaterThanOrEqual(1);
      expect(examples.length).toBeLessThanOrEqual(2);
      expect(examples.some((ex) => ex.includes("<이름>"))).toBe(true);
      for (const ex of examples) {
        // 예시가 문단 하나 길이다(모델이 짧게 끝내지 않게). 따옴표 안 인용 자리는 "<원문 그대로>"뿐(지어낸 대사 없음)
        const inner = ex.replace(/^"|"$/g, "");
        const len = Array.from(inner).length;
        expect(len, `${t} 예시 ${len}자`).toBeGreaterThanOrEqual(PARAGRAPH_MIN);
        expect(len, `${t} 예시 ${len}자`).toBeLessThanOrEqual(PARAGRAPH_MAX);
        for (const [, q] of inner.matchAll(/"([^"]*)"/g)) expect(q).toBe("<원문 그대로>");
        expect((ex.match(/\{\{stat:/g) ?? []).length).toBeLessThanOrEqual(1);
        expect(ex.replace(/\{\{stat:[^}]*\}\}/g, "")).not.toMatch(/\d/);
        // 예시에도 '우리'·'나'·'너'·'당신'이 없다
        expect(ex).not.toMatch(/우리|(?<![가-힣])나(?:는|도|가)|(?<![가-힣])너(?:는|도|가)|당신/);
        // v2.4: 예시마다 그 인물의 과감한 판정이 한 번 들어간다(실명 자리로)
        expect(ex, `${t} 예시 판정`).toMatch(/(?:주범|진행자|반장|확정|우두머리|범인)[^.!]*<이름>|<이름>[^.!]*(?:주범|진행자|반장|확정|우두머리|범인)/);
      }
      // 따옴표로 묶은 말(인물이 쓰는 말투 예)에도 글자로 쓴 숫자가 없다
      for (const [, q] of line.matchAll(/"([^"]*)"|'([^']*)'/g)) expect((q ?? "").replace(/\{\{stat:[^}]*\}\}/g, "")).not.toMatch(/\d/);
      // 인물 설명의 말투 예는 작은따옴표다(큰따옴표는 대화 원문에만 쓰라는 system 규칙과 맞춘다)
      expect(line.split("예: ")[0]).not.toContain('"');
    }
    // 잔소리: 행동을 꼬집고 근거 인용, 통계 낭독이 아니다. 판정은 별명·역할 규정·'이건 유죄'
    expect(style("fact")).toContain("잔소리");
    expect(style("fact")).toContain("근거로 인용");
    expect(style("fact")).toContain("통계를 읽어 주는 게 아니라");
    expect(style("fact")).toContain("다 보여");
    expect(style("fact")).toContain("찌질하다·한심하다 같은 디스나 가벼운 욕도 웃자고 하는 정도면 된다");
    expect(style("fact")).not.toContain("남의 속을 아는 척하지 않고");
    expect(style("fact")).toContain("'이 방 실세는 <이름>이다'");
    // 담임 선생님: 다정한 해요체 + 학생별 종합 의견, 칭찬·응원과 고칠 점을 함께. 판정은 역할·상장
    expect(style("warm").startsWith("담임 선생님. ")).toBe(true);
    expect(style("warm")).toContain("해요체");
    expect(style("warm")).toContain("종합 의견");
    expect(style("warm")).toContain("서로를 이해하는 쪽");
    expect(style("warm")).toContain("고칠 점");
    expect(style("warm")).toContain("응원으로 맺는다");
    expect(style("warm")).toContain("학생의 마음도 담임의 눈으로 다정하게 짐작해 말해 준다(틀려도 괜찮다)");
    expect(style("warm")).toContain("성격 묘사·집안 사정은 적지 않는다");
    expect(style("warm")).toContain("상장 이름");
    expect(style("warm")).not.toContain("상담");
    expect(style("show")).toContain("별명");
    expect(style("show")).toContain("(자막: …)");
    expect(style("show")).toContain("'여러분'으로 말을 걸지 않는다");
    expect(style("show")).toContain("'오늘의 MVP는 <이름>!'");
    expect(style("docu")).toContain("이 무리는 해가 지면 비로소 활발해진다");
    expect(style("docu")).toContain("깎아내리지 않고");
    expect(style("docu")).toContain("엉뚱한 생태 가설");
    expect(style("docu")).toContain("가설은 속마음·감정·호감까지 세워도 된다");
    expect(style("docu")).not.toContain("이유는 기록되지 않은 것으로 둔다");
    for (const part of ["사건 개요", "증거물", "용의 패턴", "결론"]) expect(style("detective")).toContain(part);
    expect(style("detective")).toContain("범인을 지목하고('범인은 <이름>이다')");
    expect(style("detective")).toContain("속마음·연애 감정도 추리한다(가령 증거는 부족하지만 감은 확실하다는 결론)");
    expect(style("detective")).not.toContain("추리하지 않는다");
    expect(style("detective")).toContain("실제 범죄·불법 행위로 몰지 않는다");
  });

  it("말투마다 세 부분(인트로 종합 → 개인별 특징 → 마무리)을 순서대로 싣고, 호출마다 자기 몫의 구성 줄만 싣는다. 개인별은 사람마다 섹션 하나", () => {
    for (const t of PICKABLE_TONES) {
      for (const p of [hugePayload(t), payload("couple", t)]) {
        const { intro, people, others, outro } = reportParts(p);
        for (const c of buildRequests(p)) {
          const body = instructionOf(c.req);
          expect(body).toContain(`리포트 구성(「${TONES[t].label}」의 형식이다. 리포트 한 편을 응답 ${buildRequests(p).length}개가 같은 대화를 보고 동시에 나눠 쓰고, 화면이 세 부분을 이 순서로 붙인다. 섹션의 part는 앞의 키다):`);
          const heads = ["[1. 인트로 종합 리포트]", "[2. 개인별 특징 리포트]", "[3. 마무리 리포트]"].map((h) => body.indexOf(`\n${h} `));
          expect(heads.every((i) => i >= 0), `${t} ${c.part}`).toBe(true);
          expect(heads).toEqual([...heads].sort((a, b) => a - b));
          const at = (part: { key: string; title: string }) => body.indexOf(`\n- ${part.key} 「${part.title}」: `);
          const isPeople = c.part === "people" || c.part === "people_rest";
          const mine = c.part === "intro" ? intro : c.part === "outro" ? outro : [people];
          const theirs = [...intro, people, ...(others ? [others] : []), ...outro].filter((x) => !mine.includes(x) && !(isPeople && x === others));
          // 자기 몫은 구성 줄이 순서대로, 다른 몫은 구성 줄이 없다
          const order = mine.map(at);
          expect(order.every((i) => i >= 0), `${t} ${c.part}`).toBe(true);
          expect(order).toEqual([...order].sort((a, b) => a - b));
          for (const x of theirs) expect(at(x), `${t} ${c.part} ${x.key}`).toBe(-1);
          expect((body.match(/\n- [a-z_]+ 「[^」]+」: 사람마다 섹션 하나\(about은 그 사람\)/g) ?? []).length).toBe(isPeople ? 1 : 0);
          expect(body).toContain(`의 목소리와 형식으로 쓴다.`);
          expect(body).toContain(`사실을 설명하는 데서 멈추지 말고 ${TONES[t].label}의 관점에서 판정·해석을 내린다.`);
          expect(body).toContain("사람마다 별명·역할 규정 같은 그 인물의 판정이 하나 이상 들어간다");
        }
        expect(ins(p, "intro")).toContain(`목소리: 헤드라인과 첫 섹션 제목부터 마지막 문단까지 ${TONES[t].label}의 목소리와 형식으로 쓴다.`);
        expect(ins(p, "outro")).toContain(`목소리: 첫 섹션 제목부터 마지막 문단까지 ${TONES[t].label}의 목소리와 형식으로 쓴다.`);
      }
    }
    // 개인별(v2.5): 단톡 full은 문단 4~6개(적어도 4개, 잔소리 3~5개 + 인정 1), 1:1 full은 5~7개, medium 단톡은 3~5개, small 1:1은 3~4개
    const fact = ins(hugePayload("fact"), "people");
    expect(fact).toMatch(/- nag_cards 「사람별 잔소리 카드」: 사람마다 섹션 하나\(about은 그 사람\), 한 사람에 문단 4~6개\(적어도 4개\)\. [^\n]*잔소리 3~5개 \+ 인정 1[^\n]*근거 인용/);
    expect(ins(longPair("fact"), "people")).toMatch(/- nag_cards 「사람별 잔소리 카드」: [^\n]*문단 5~7개\(적어도 5개\)\. [^\n]*잔소리 4~6개 \+ 인정 1/);
    expect(ins(bigPayload("fact"), "people")).toMatch(/- nag_cards 「사람별 잔소리 카드」: [^\n]*문단 3~5개\(적어도 3개\)\. [^\n]*잔소리 2~4개 \+ 인정 1/);
    expect(ins(payload("couple", "fact"), "people")).toMatch(/- nag_cards 「사람별 잔소리 카드」: [^\n]*문단 3~4개\(적어도 3개\)/);
    // 인트로·마무리 섹션은 섹션 하나씩, 단계의 문단 수(full 4~5개)
    expect(ins(hugePayload("fact"), "intro")).toContain("- nag_open 「첫 잔소리」: 섹션 하나, about은 group(1:1이면 pair), 문단 4~5개. ");
    expect(ins(hugePayload("fact"), "outro")).toContain("- nag_last 「마지막 한마디」: 섹션 하나, about은 group(1:1이면 pair), 문단 4~5개. ");
    // 그 밖의 멤버: 개인별 뒤 호출의 섹션 하나에 한 사람 한 문단
    const huge = hugePayload("fact");
    const others = peopleOrder(huge).others.map((i) => huge.members[i]);
    expect(ins(huge, "people_rest")).toContain(`- nag_others 「그 밖의 멤버 한 줄 잔소리」: 섹션 하나, about은 group, 기호 ${codesOf(huge, others)} 6명을 한 사람에 문단 하나씩(문단 6개). `);
    expect(allIns(longPair("fact")).join("\n")).not.toContain("nag_others");
    const show = ins(payload("group", "show"), "people");
    expect(show).toMatch(/- show_cast 「출연자 소개」: [^\n]*별명\(보이는 행동으로 지은 것\)과 캐치프레이즈/);
    // 캐치프레이즈는 실제로 되풀이한 말(큰따옴표 + 근거)이나 MC 자막뿐, 멤버 입에 지어낸 말을 넣지 않는다(Fix 3)
    expect(show).toMatch(/- show_cast [^\n]*캐치프레이즈는 그 사람이 실제로 되풀이한 말을 큰따옴표로 옮겨 근거로 달거나 MC 자막 \(자막: …\)으로 쓴다\. 안 한 말을 그 사람 입에 넣지 않는다\./);
    expect(show).toContain("그 사람이 실제로 되풀이한 말을 캐치프레이즈로 소개하고");
    expect(show).not.toContain("캐치프레이즈 한 줄로 소개");
    // small: 인트로·마무리 하나씩(VCR·시상식은 빠진다)
    expect(allIns(payload("group", "show")).join("\n")).not.toContain("show_vcr");
    expect(ins(hugePayload("show"), "intro")).toMatch(/- show_vcr 「하이라이트 VCR」: [^\n]*\(자막: …\)/);
    expect(ins(hugePayload("show"), "outro")).toMatch(/- show_corner 「이 방 시상식」: [^\n]*수상자를 과감하게 정하고/);
    const detective = hugePayload("detective");
    expect(ins(detective, "outro")).toMatch(/- case_open 「미해결 의문」: [^\n]*속마음·연애 감정까지 추리해도 된다/);
    expect(ins(detective, "people")).toMatch(/- case_people 「관련자 프로필」: [^\n]*인상착의·외모는 적지 않는다/);
    expect(ins(detective, "outro")).toMatch(/- case_verdict 「수사 결론」: [^\n]*사건마다 범인을 지목해/);
    // 담임 선생님: 학생별 종합 의견은 사람마다 길게, 칭찬·응원과 고칠 점을 함께. 학급 개요로 시작해 담임의 편지로 끝난다
    const warm = hugePayload("warm");
    expect(ins(warm, "people")).toMatch(/- care_people 「학생별 종합 의견」: 사람마다 섹션 하나[^\n]*사람마다 길게[^\n]*칭찬·응원과 고칠 점을 함께 쓴다/);
    expect(ins(warm, "intro")).toMatch(/- care_open 「학급 개요」: /);
    expect(ins(warm, "outro")).toMatch(/- care_letter 「담임의 편지」: /);
    expect(allIns(warm).join("\n")).not.toContain("rec_");
  });

  it("마무리 구성(잔소리·편지·클로징)만 멤버를 이름으로 불러 말을 건다: '우리' 없이, 한쪽 편 없이, 질문으로 끝내지 않는다", () => {
    const closing = { fact: "nag_last", warm: "care_letter", show: "show_close" } as const;
    for (const [t, key] of Object.entries(closing)) {
      for (const p of [payload("couple", t as PickableTone), hugePayload(t as PickableTone)]) {
        const body = ins(p, "outro");
        const line = body.split("\n").find((l) => l.startsWith(`- ${key} `))!;
        expect(line).toContain("이 섹션만 방 밖의 관찰자가 멤버들을 이름으로 불러");
        expect(line).toContain("'우리'로 쓰지 않는다");
        expect(line).toContain("한쪽 편을 들지 않고");
        expect(line).not.toContain("속마음도 대신 말하지 않으며");
        expect(line).toContain("마지막 판정(누구의 속마음이든 점수든)을 과감하게 못 박는다(틀려도 좋다)");
        expect(line).toContain("질문으로 끝내지 않는다");
        // v2.5: 마무리 호출은 앞 호출이 쓴 것을 못 보므로 '이 방을 대표하는 장면'을 꺼낸다
        expect(line).toContain("이 방을 대표하는 장면 하나를 근거 인용으로 꺼내고");
        // 다른 구성·호출에는 말 걸기 허용이 없다
        expect(allIns(p).join("\n").split("이 섹션만 방 밖의 관찰자가").length).toBe(2);
      }
    }
    for (const t of ["docu", "detective"] as const) {
      expect(allIns(hugePayload(t)).join("\n")).not.toContain("이 섹션만 방 밖의 관찰자가");
    }
  });

  it("분량 단계: 보낸 메시지 수로 small(<300)·medium(<1,500)·full을 고른다. 인용 상한은 30 이하, small은 인트로·마무리를 하나씩", () => {
    expect([VOLUME_SMALL_BELOW, VOLUME_FULL_FROM]).toEqual([300, 1500]);
    expect([0, 299, 300, 1499, 1500, 50_000].map(volumeTier)).toEqual(["small", "small", "medium", "medium", "full", "full"]);
    for (const v of Object.values(VOLUMES)) expect(v.quotes).toBeLessThanOrEqual(MAX_QUOTES_PER_REPORT);
    expect([VOLUMES.small.blockParts, VOLUMES.medium.blockParts, VOLUMES.full.blockParts]).toEqual([1, 2, 2]);
    expect([payload(), bigPayload(), hugePayload(), longPair()].map((p) => volumeTier(p.msgSent))).toEqual(["small", "medium", "full", "full"]);
    // v2.5: 부분별 목표(full: 인트로·마무리 섹션당 4~5문단, 사람당 4~6문단, 1:1은 5~7문단)
    expect([VOLUMES.full.blockParagraphs, VOLUMES.full.peopleParagraphs, VOLUMES.full.pairParagraphs]).toEqual(["4~5", "4~6", "5~7"]);
  });

  it("분량·숫자 줄(v2.5, 호출마다): 그 호출의 섹션 수, 문단마다 4~7문장 250~400자(적어도 250자), 본문 하한·상한, 인용 섹션마다·이번 응답 몫, 마무리 몫", () => {
    const closing = { fact: "nag_last", warm: "care_letter", show: "show_close", docu: "docu_outro", detective: "case_verdict" };
    const paragraphRule =
      "섹션마다 문단 수는 구성 줄에 적힌 대로다. 문단 하나는 4~7문장, 250~400자다. 문단마다 적어도 250자를 쓴다: 한두 문장으로 짧게 끝내지 말고 장면 → 근거(인용) → 그 말투의 판정·리액션 → 앞뒤 흐름이나 다른 멤버의 반응을 이어서 한 문단을 채운다(예시가 문단 하나의 길이다).";
    for (const t of PICKABLE_TONES) {
      const p = longPair(t);
      const outro = t === "fact" ? 1 : 2;
      const [s1, s2, s3] = quoteShares([2, 2, outro], VOLUMES.full);
      expect(ins(p, "intro")).toContain(`분량: 이번 응답은 인트로 섹션 2개다. ${paragraphRule} 이번 응답의 본문(문단 글)은 적어도 2,000자, 많아야 4,000자다. 근거 인용은 섹션마다 1~3개, 이번 응답 전체 ${s1}개 이하.`);
      expect(ins(p, "people")).toContain(`분량: 이번 응답은 개인별 섹션 2개다(사람 2명). ${paragraphRule} 이번 응답의 본문(문단 글)은 적어도 2,500자, 많아야 5,600자다. 근거 인용은 섹션마다 1~3개, 이번 응답 전체 ${s2}개 이하.`);
      expect(ins(p, "outro")).toContain(
        `분량: 이번 응답은 마무리 섹션 ${outro}개다. ${paragraphRule} 이번 응답의 본문(문단 글)은 적어도 ${(outro * 1000).toLocaleString("en-US")}자, 많아야 ${(outro * 2000).toLocaleString("en-US")}자다. 근거 인용은 섹션마다 1~3개, 이번 응답 전체 ${s3}개 이하이고, 마지막 구성 ${closing[t]} 섹션에도 2개를 단다.`,
      );
      for (const body of allIns(p)) {
        expect(body).not.toContain("재료:");
        expect(body).toContain("숫자는 양념: 통계 자리표시자는 섹션마다 0~2개, 장면을 받쳐 줄 때만 쓴다. 숫자를 나열하지 않는다. 안 되는 예:");
        expect(body).toContain("사람마다 숫자를 줄줄이 대기");
        expect(body).toContain("문단마다 통계 하나를 읽고 해설하기");
      }
    }
    // 40명 단톡: 인트로 2 + 개인별 3 + (개인별 3 + 그 밖의 멤버 1) + 마무리 2
    const huge = hugePayload("show");
    expect(allIns(huge).map((b) => /분량: 이번 응답은 ([^.]+)\./.exec(b)![1])).toEqual([
      "인트로 섹션 2개다",
      "개인별 섹션 3개다(사람 3명)",
      "개인별 섹션 4개다(사람 3명 + 그 밖의 멤버 1)",
      "마무리 섹션 2개다",
    ]);
  });

  it("분량(small·medium): 재료가 적은 대화는 분량을 줄이고, 구성 설명의 개수를 상한으로 보며 되풀이·지어내기로 채우지 않는다", () => {
    const small = payload();
    expect(ins(small, "intro")).toContain("분량: 이번 응답은 인트로 섹션 1개다.");
    expect(ins(small, "intro")).toContain("이번 응답의 본문(문단 글)은 적어도 500자, 많아야 1,200자다. 근거 인용은 섹션마다 1~2개, 이번 응답 전체 2개 이하.");
    expect(ins(small, "intro")).toContain("- nag_open 「첫 잔소리」: 섹션 하나, about은 group(1:1이면 pair), 문단 2~3개. ");
    expect(allIns(small).join("\n")).not.toContain("- nag_room ");
    expect(ins(small, "intro")).toContain("reading_notes(6개 이하), chemistry(케미 온도)도 이 응답이 쓴다");
    for (const body of allIns(small)) {
      expect(body).toContain("숫자는 양념: 통계 자리표시자는 섹션마다 0~1개");
      expect(body).toContain("재료: 보낸 대화가 6개로 많지 않다. 구성 설명에 적힌 개수(문단·잔소리·장면·상)는 상한으로 보고 대화에 있는 만큼만 쓴다.");
      expect(body).toContain("같은 장면·같은 인용을 되풀이하거나 없는 장면·대사를 지어내 분량을 채우지 않는다");
    }
    const medium = bigPayload();
    expect(buildRequests(medium).map((c) => c.part)).toEqual(["intro", "people", "people_rest", "outro"]);
    expect(ins(medium, "intro")).toContain("분량: 이번 응답은 인트로 섹션 2개다.");
    expect(ins(medium, "intro")).toContain("- nag_open 「첫 잔소리」: 섹션 하나, about은 group(1:1이면 pair), 문단 3~4개. ");
    expect(ins(medium, "outro")).toContain("분량: 이번 응답은 마무리 섹션 1개다.");
    expect(ins(medium, "people")).toContain("이번 응답의 본문(문단 글)은 적어도 2,250자, 많아야 6,000자다. 근거 인용은 섹션마다 1~3개");
    expect(medium.msgSent).toBe(649);
    expect(ins(medium, "intro")).toContain("재료: 보낸 대화가 649개로 많지 않다.");
  });

  it("문단 합계(v2.5, 호출마다): 구성 줄이 시키는 최대 문단 수 × 400자가 그 호출의 본문 상한이고, full은 그 호출의 출력 창(①은 0초 시작, 나머지는 ①의 첫 토큰 뒤 시작) 안이다", () => {
    // 지시 글에서 직접 읽는다: 분량 줄의 글자 수·본문 상한·섹션 수, 구성 줄마다 섹션 수와 문단 수, 이번 응답의 사람 수
    const max = (range: string) => Number(range.split("~")[1]);
    const smallGroup = (t: PickableTone) =>
      buildPayload({ messages: syntheticGroupChat(8, 4), tone: t, concept: "group", kind: "group", tokenBudget: 1_000_000, tokensPerChar: 1 });
    const cases = [
      ["small", smallGroup],
      ["small", (t: PickableTone) => payload("couple", t)],
      ["medium", bigPayload],
      ["full", hugePayload],
      ["full", longPair],
    ] as const;
    const e = DEADLINE_ESTIMATE;
    for (const [tier, make] of cases) {
      for (const t of PICKABLE_TONES) {
        const p = make(t);
        expect(volumeTier(p.msgSent)).toBe(tier);
        for (const c of buildRequests(p)) {
          const body = instructionOf(c.req);
          const volume = /분량: 이번 응답은 [^\n]*?섹션 (\d+)개다[^\n]*?문단 하나는 \d+~\d+문장, (\d+~\d+)자다[^\n]*?많아야 ([\d,]+)자다/.exec(body)!;
          const [lo, hi] = volume[2].split("~").map(Number);
          const bodyCharsMax = Number(volume[3].replaceAll(",", ""));
          const persons = c.people.length;
          let sections = 0;
          let paragraphs = 0;
          for (const line of body.split("\n").filter((l) => /^- [a-z_]+ 「/.test(l))) {
            const own = /문단 (\d+~\d+|\d+)개/.exec(line)![1];
            if (line.includes("」: 사람마다 섹션 하나")) {
              sections += persons;
              paragraphs += persons * max(own);
            } else {
              expect(line).toMatch(/」: 섹션 하나, about은 group/);
              sections += 1;
              paragraphs += own.includes("~") ? max(own) : Number(own);
            }
          }
          const label = `${tier} ${t} ${c.part}`;
          expect(sections, `${label} 섹션 수`).toBe(Number(volume[1]));
          expect(lo).toBeLessThan(hi);
          expect(paragraphs * hi, `${label} ${paragraphs}문단 × ${hi}자`).toBe(bodyCharsMax);
          // 마감 어림: 본문(위쪽 끝) + JSON + 생각 토큰이 그 호출의 출력 창 × 출력 속도 안에 든다
          const outputTokens = paragraphs * hi * TOKENS_PER_CHAR + e.jsonTokens + e.thinkingTokens;
          const startsAt = c.part === "intro" ? 0 : e.ttftSec;
          const fits = (EPISODE_DEADLINE_MS / 1000 - startsAt - e.ttftSec - e.marginSec) * e.outputTokensPerSec;
          expect(outputTokens, `${label} 출력 ${outputTokens}토큰`).toBeLessThanOrEqual(fits);
          expect(outputTokens, `${label} 출력 상한`).toBeLessThanOrEqual(DEFAULT_REPORT_MAX_TOKENS);
        }
      }
    }
  });

  it("마감 어림(v2.5): 출력 120 tok/s·첫 토큰 25초·생각 2,500토큰. ①의 출력 창은 230초, ①의 첫 토큰 뒤 시작하는 나머지는 205초이고, 개인별을 나누지 않으면 빠듯하다", () => {
    expect(DEADLINE_ESTIMATE).toEqual({ outputTokensPerSec: 120, ttftSec: 25, marginSec: 15, jsonTokens: 3_200, thinkingTokens: 2_500 });
    // 실측(report-7): 8,973토큰 / (79초 − 첫 토큰 20초) ≈ 152 tok/s. 어림 속도는 그보다 낮다
    expect(DEADLINE_ESTIMATE.outputTokensPerSec).toBeLessThan(8_973 / (79 - 20));
    expect([PARAGRAPH_MIN, PARAGRAPH_MAX]).toEqual([250, 400]);
    const e = DEADLINE_ESTIMATE;
    const window = (startsAt: number) => (EPISODE_DEADLINE_MS / 1000 - startsAt - e.ttftSec - e.marginSec) * e.outputTokensPerSec;
    expect([window(0), window(e.ttftSec)]).toEqual([27_600, 24_600]);
    const max = (range: string) => Number(range.split("~")[1]);
    const overhead = e.jsonTokens + e.thinkingTokens;
    // 개인별을 나누지 않았다면(사람 6명 + 그 밖의 6명): 42문단 × 400자 + 5,700 = 22,500토큰. 창 안이지만 2,100토큰(17초)만 남는다
    const whole = (PEOPLE_CAP * max(VOLUMES.full.peopleParagraphs) + 6) * PARAGRAPH_MAX * TOKENS_PER_CHAR + overhead;
    expect(whole).toBe(22_500);
    expect(window(e.ttftSec) - whole).toBe(2_100);
    // 나누면: ②a 3명 18문단, ②b 3명 + 그 밖의 6명 24문단
    const a = 3 * max(VOLUMES.full.peopleParagraphs) * PARAGRAPH_MAX + overhead;
    const b = (3 * max(VOLUMES.full.peopleParagraphs) + 6) * PARAGRAPH_MAX + overhead;
    expect([a, b]).toEqual([12_900, 15_300]);
    expect(window(e.ttftSec) - b).toBeGreaterThanOrEqual(9_000);
    // 인트로(2섹션 × 5문단)는 ① 창 안에 넉넉하다
    expect(2 * max(VOLUMES.full.blockParagraphs) * PARAGRAPH_MAX + overhead).toBeLessThanOrEqual(window(0) / 2);
    // 출력 상한은 호출 하나의 위쪽 끝보다 커서 리포트를 먼저 자르지 않는다(실제 한계는 마감)
    expect(DEFAULT_REPORT_MAX_TOKENS).toBeGreaterThanOrEqual(whole);
  });

  it("couple 지시: 방·참여자 수, 연애·썸 소재(한쪽 편 없이, 판정은 대화 습관에만), 1:1은 두 사람 중심", () => {
    const body = instructionOf(buildRequest(longPair()));
    expect(ins(longPair(), "people").split("\n").at(-1)).toContain("nag_cards 「사람별 잔소리 카드」에서 두 사람 각자 섹션 하나씩.");
    expect(body).toContain("방: 1:1 · 참여자 2명(<members>의 범례)");
    expect(body).toMatch(/소재\(연애·썸\): [^\n]*stats\.crossed는 그대로 묘사하고[^\n]*한쪽 편을 들지 않되[^\n]*앞날은 그 인물의 관점에서 과감하게 점쳐도 된다/);
    expect(body).toContain(
      "사람: 1:1 두 사람이다. 같은 형식에서 두 사람 중심으로 쓴다. nag_cards 「사람별 잔소리 카드」에서는 두 사람 각자 섹션 하나씩 깊게 쓰고, 인트로 종합과 마무리는 about을 pair로 두고 두 사람 사이에 오간 것을 쓴다.",
    );
    for (const b of allIns(longPair())) {
      expect(b).not.toContain("철수");
      expect(b).not.toContain("민지");
    }
    // 같은 말투면 컨셉이 달라도 구성은 같다(방 종류는 소재만 정한다)
    const parts = (b: string[]) => b.map((x) => x.split("\n").filter((l) => l.startsWith("- ")));
    // (같은 분량 단계끼리 본다: 개인별의 문단 수는 단계마다 다르다)
    expect(parts(allIns(payload("group")))).toEqual(parts(allIns(payload("couple"))));
  });

  it("group 지시: 단톡 소재, 참여자가 적으면 모두 섹션 하나씩, 많으면 상위 6명만 길게, 그다음 순위는 그 밖의 멤버 섹션에서 한 문단씩", () => {
    const body = instructionOf(buildRequest(payload("group")));
    expect(body).toContain("방: 단톡방 · 참여자 2명(<members>의 범례)");
    expect(body).toMatch(/소재\(친구·가족 단톡방\): [^\n]*명장면/);
    const three = buildPayload({ messages: syntheticGroupChat(3, 2), tone: "warm", concept: "group", kind: "group", tokenBudget: 1_000_000, tokensPerChar: 1 });
    const threeNames = peopleOrder(three).persons.map((i) => three.members[i]);
    expect(instructionOf(buildRequest(three))).toContain(
      `사람: 개인별 섹션은 <conversation>에 줄이 있는 멤버 중 메시지가 많은 3명이 care_people 「학생별 종합 의견」에서 한 사람에 하나씩 받는다. 메시지 많은 순으로 기호 ${codesOf(three, threeNames)}(<members>의 범례)다. <conversation>에 줄이 없는 멤버는 짐작으로 묘사하지 않는다.`,
    );
    // full: 상위 6명만 섹션, 그다음(<stats>에 있는 12명 안) 많아야 6명은 그 밖의 멤버 섹션에서 한 문단씩, 그 아래는 이름 없이 한 문장
    const hp = hugePayload();
    const order = peopleOrder(hp);
    const names = (who: number[]) => who.map((i) => hp.members[i]);
    expect(instructionOf(buildRequest(hp))).toContain(
      `사람: 개인별 섹션은 <conversation>에 줄이 있는 멤버 중 메시지가 많은 6명이 nag_cards 「사람별 잔소리 카드」에서 한 사람에 하나씩 받는다. 메시지 많은 순으로 기호 ${codesOf(hp, names(order.persons))}(<members>의 범례)다. 그다음 6명(기호 ${codesOf(hp, names(order.others))})은 nag_others 「그 밖의 멤버 한 줄 잔소리」 섹션 하나에서 한 사람에 문단 하나씩 다룬다. 그 밖의 멤버는 이름을 부르지 않고 '나머지 멤버들'처럼 한 문장으로 묶는다. <conversation>에 줄이 없는 멤버는 짐작으로 묘사하지 않는다.`,
    );
    expect(instructionOf(buildRequest(hugePayload("detective")))).toContain("에서 한 사람에 하나씩 받는다.");
    expect(instructionOf(buildRequest(hugePayload("detective")))).toContain("은 case_others 「그 밖의 관련자」 섹션 하나에서");
    // 한 문단을 받는 사람은 모두 <stats>(12명)에 있다
    const top = Object.entries(hp.stats.byPerson).sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1)).slice(0, PROMPT_STATS_MAX_PEOPLE).map(([n]) => n);
    for (const i of order.others) expect(top).toContain(hp.members[i]);
    expect(order.others.length).toBeLessThanOrEqual(6);
    // 8명 단톡(실측 방과 같은 크기): 6명 섹션 + 2명은 그 밖의 멤버에서 한 문단씩
    const eight = buildPayload({ messages: syntheticGroupChat(8, 60), tone: "show", concept: "group", kind: "group", tokenBudget: 200_000, tokensPerChar: 1 });
    expect(peopleShape(eight)).toEqual({ persons: 6, others: 2 });
    expect(ins(eight, "people_rest")).toMatch(/- show_others 「그 밖의 출연자」: 섹션 하나, about은 group, 기호 [A-Z], [A-Z] 2명을 한 사람에 문단 하나씩\(문단 2개\)\. /);
  });

  it("개인별 섹션은 <conversation>에 말한 사람만: 말한 사람이 6명 이하이면 그 사람들만 섹션을 받는다", () => {
    const big = bigPayload();
    expect(speakerCount(big)).toBeGreaterThan(5);
    expect(speakerCount(payload())).toBe(2);
    // 10명 방에서 세 사람만 말했다
    const rows = syntheticGroupChat(3, 2);
    const quiet = buildPayload({ messages: rows, tone: "fact", concept: "group", kind: "group", tokenBudget: 1_000_000, tokensPerChar: 1 });
    const tenMembers = { ...quiet, members: [...quiet.members, ...Array.from({ length: 7 }, (_, i) => `조용${i}`)] };
    expect(speakerCount(tenMembers)).toBe(3);
    const ten = instructionOf(buildRequest(tenMembers));
    expect(peopleShape(tenMembers)).toEqual({ persons: 3, others: 0 });
    expect(ten).toContain("사람: 개인별 섹션은 <conversation>에 줄이 있는 멤버 중 메시지가 많은 3명이 nag_cards 「사람별 잔소리 카드」에서 한 사람에 하나씩 받는다.");
    expect(ten).toContain(" 그 밖의 멤버는 이름을 부르지 않고 '나머지 멤버들'처럼 한 문장으로 묶는다. <conversation>에 줄이 없는 멤버는 짐작으로 묘사하지 않는다.");
    expect(allIns(tenMembers).join("\n")).not.toContain("nag_others");
    // 말하지 않은 멤버(조용0)는 개인별 섹션을 받지 않는다(기호 D)
    const four = { ...quiet, members: [...quiet.members, "조용0"] };
    expect(peopleShape(four)).toEqual({ persons: 3, others: 0 });
    expect(instructionOf(buildRequest(four))).not.toMatch(/기호 [^)]*D/);
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

  it("system의 데이터 계약(v2.7): 묶음 줄 m<번호>+<k>와 ' ¦ ', 접은 표시 ×n, 앞 줄에 접거나 뺀 반응·미디어, 근거는 줄 머리 번호와 메시지 하나", () => {
    const s = systemOf(buildRequest(payload()));
    expect(s).toContain("머리가 `m<번호>+<k>`인 줄은 한 사람이 같은 분에 보낸 메시지 k+1개(번호 차례)를 묶은 것이고, \" ¦ \"가 메시지 사이 경계다.");
    expect(s).toContain("`[사진×3]`은 사진 3장, `ㅋㅋ×5`는 자모·기호뿐인 짧은 반응 5번이다.");
    expect(s).toContain("미디어·짧은 반응만 따로 보낸 것은 같은 사람의 바로 앞 줄 끝에 접었고(더 늦게 보낸 것일 수 있다), 접을 곳이 없으면 뺐다.");
    expect(s).toContain("(묶음 줄은 m<번호+k>까지 이어진다)");
    expect(s).toContain("msg_id는 줄 머리의 m번호(`m<번호>+<k>`면 m<번호>)");
    expect(s).toContain("quote는 메시지 하나(\" ¦ \" 사이 한 칸)의 본문을 글자 그대로 잘라 온 부분이다. 고치거나 합치지 않고 \" ¦ \"를 넘지 않는다.");
    expect(s).toContain("접은 표시(×n)는 근거가 아니다");
    expect(s).not.toContain("msg_id는 줄 앞의 m번호 그대로");
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
        cache_control: { type: "ephemeral" },
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

  it("크기: system + 가장 긴 지시(모든 호출)가 PROMPT_RESERVE_TOKENS 안에 든다", () => {
    const bodies = PICKABLE_TONES.flatMap((t) => [payload("couple", t), payload("group", t), bigPayload(t), hugePayload(t), longPair(t)].flatMap(allIns));
    const longest = Math.max(...bodies.map((b) => b.length));
    expect((systemOf(buildRequest(payload())).length + longest) * TOKENS_PER_CHAR).toBeLessThanOrEqual(PROMPT_RESERVE_TOKENS);
  });

  it("지시 자리: system이면 messages 2개(마지막이 role system), user면 messages 1개에 글 블록 2개(데이터 뒤)", () => {
    const asSystem = requestMessages("DATA", "지시", "system");
    expect(asSystem).toEqual([
      { role: "user", content: [{ type: "text", text: "DATA", cache_control: { type: "ephemeral" } }] },
      { role: "system", content: "지시" },
    ]);
    // user 자리여도 캐시 지점은 데이터 블록 끝이다(지시는 그 뒤라 호출마다 달라도 된다)
    const asUser = requestMessages("DATA", "지시", "user");
    expect(asUser).toHaveLength(1);
    expect(asUser[0].role).toBe("user");
    expect(asUser[0].content).toEqual([
      { type: "text", text: "DATA", cache_control: { type: "ephemeral" } },
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
    // v2.8: 케미 온도는 섹션 앞(끊긴 응답에서도 남게), MBTI는 섹션 끝(문단을 다 쓴 뒤에 추측한다). 모두 required다
    const top = ["safety", "declined_topics", "reading_notes", "headline", "dek", "chemistry", "sections"];
    expect(Object.keys(schema.properties)).toEqual(top);
    expect(schema.required).toEqual(top);
    const section = schema.properties.sections.items!.properties;
    const sectionKeys = ["part", "icon", "title", "about", "paragraphs", "evidence", "mbti", "mbti_reason"];
    expect(Object.keys(section)).toEqual(sectionKeys);
    expect((schema.properties.sections.items as unknown as { required: string[] }).required).toEqual(sectionKeys);
    expect(Object.keys(section.paragraphs.items!.properties)).toEqual(["key", "text", "evidence_ids"]);
    expect(Object.keys(section.evidence.items!.properties)).toEqual(["id", "msg_id", "quote"]);
    expect(Object.keys(schema.properties.reading_notes.items!.properties)).toEqual(["range", "note"]);
  });
});
