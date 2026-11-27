import { describe, expect, it } from "vitest";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages";
import { EPISODE_DEADLINE_MS, MAX_QUOTES_PER_REPORT, PROMPT_RESERVE_TOKENS, PROMPT_STATS_MAX_MONTHS, PROMPT_STATS_MAX_PEOPLE, TOKENS_PER_CHAR } from "@/lib/config";
import type { ChatMessage } from "@/lib/parse/parse";
import { buildPayload, legendText, type Payload } from "@/lib/payload/build";
import { STAT_PATHS } from "@/lib/stats/paths";
import { statsForPrompt } from "@/lib/stats/view";
import { syntheticGroupChat } from "@/test/syntheticChat";
import { CONCEPTS, DEFAULT_TONE, PICKABLE_TONES, type PickableTone, TONE_KEYS, TONES, type Tone } from "./concepts";
import {
  buildRequest,
  DEADLINE_ESTIMATE,
  PARAGRAPH_MAX,
  PARAGRAPH_MIN,
  PROMPT_VERSION,
  PEOPLE_CAP,
  peopleShape,
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

/** 40명 × 60개월 단톡: 예산이 작아 전체 기간에서 골라 보낸다(689개, medium 분량) */
const bigPayload = (tone: PickableTone = "fact") =>
  buildPayload({ messages: syntheticGroupChat(40, 60), tone, concept: "group", kind: "group", tokenBudget: 20_000, tokensPerChar: 1 });
/** 같은 40명 단톡을 예산을 키워 7,022개 보낸다(full 분량) */
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
    expect(reportParts(three).others).toBeUndefined();
    const small = reportParts(payload("couple", "show"));
    expect([small.intro.map((p) => p.key), small.outro.map((p) => p.key)]).toEqual([["show_open"], ["show_close"]]);
    const full = reportParts(hugePayload("show"));
    expect([full.intro.map((p) => p.key), full.people.key, full.outro.map((p) => p.key)]).toEqual([["show_open", "show_vcr"], "show_cast", ["show_corner", "show_close"]]);
  });
});

describe("buildRequest", () => {
  it("PROMPT_VERSION", () => {
    expect(PROMPT_VERSION).toBe("2026-11-report-9");
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
    const reqs = [...PICKABLE_TONES.map((t) => buildRequest(payload("couple", t))), buildRequest(payload("group"))];
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
    expect(s).toContain("성적 지향·임신·종교·정치를 멤버에게 추측해 붙이기. 대화에 나온 이야기를 그대로 전하는 것은 된다.");
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
    expect(s).toContain("근거 인용도 자리표시자도 없는 사람 섹션은 저장 전에 지워진다");
    expect(s).toContain("근거를 달았는데 원문과 맞는 근거가 하나도 없는 문단도 지워진다");
    // 문단 안 인용: 멤버의 말은 원문 그대로 큰따옴표로만. 작은따옴표는 별명·자막 등에만, 지어낸 대사는 어떤 모양으로도 안 된다(Fix 2)
    expect(s).toContain('큰따옴표("…")로 짧게, 한 글자도 바꾸거나 줄이지 않고');
    expect(s).toContain("멤버가 하지 않은 말을 그 사람의 말처럼(따옴표든 ~라고 했다든) 쓰지 않는다. 지어낸 말은 MC·내레이터 자신의 말뿐이다.");
    // Fix 3: 작은따옴표에 캐치프레이즈·자막은 없다(캐치프레이즈는 실제 말을 큰따옴표로, 자막은 (자막: …)). 말을 옮기는 말이 넓어졌고 말한 사람도 맞춘다
    expect(s).toContain("작은따옴표('…')는 별명·상 이름·사건명에만 쓰고, 바로 뒤에 말을 옮기는 말(라고·라는·란·고 했다·하고·했다·며)을 붙이지 않는다");
    expect(s).toContain("'…'이라고 불린다·'…'이라는 별명은 된다");
    expect(s).not.toContain("별명·캐치프레이즈·상 이름");
    expect(s).toContain("‘…’·「…」·『…』·《…》·〈…〉는 쓰지 않는다");
    expect(s).toContain("원문에 없는 인용(부호 안의 말, 말을 옮기는 말이 뒤에 붙은 '…'), 그 말을 안 보낸 멤버 이름과 한 문장에 둔 인용이 든 문단은 저장 전에 지워진다");
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

  it("system(v2.4 Fix 1): 관점과 판정. 속마음·호감·점수·놀림·욕까지 인물의 판단으로(틀려도 좋다), 금지는 넷뿐", () => {
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
    for (const ok of ["호감·케미 점수와 순위", "친구끼리 웃자고 하는 놀림·디스·별명", "친구끼리 쓰는 정도의 욕까지 된다", "속마음·호감·연애 감정·의도까지 인물의 관점에서 추측하거나 단정해도 된다(틀려도 좋다)"]) {
      expect(s).toContain(ok);
    }
    expect(s).toContain("따옴표에 넣지 않는다: 따옴표 안은 실제로 오간 말뿐이다");
    for (const gone of ["누구의 속마음·의도·감정도 단정하거나 추측하지 않는다", "누구의 속마음 단정·추측", "애정·관심·호감 점수", "외모 평가, 비속어, 모욕", "MBTI"]) {
      expect(s).not.toContain(gone);
    }
    // 계속 막는 넷: 지어낸 대사, 혐오·차별·성적 묘사, 진단명 단정, 자해·폭력 부추김
    expect(s).toContain("## 금지 (이것만 막는다)");
    for (const rule of ["지어낸 대사", "혐오·차별: 성별·출신 지역·인종·국적·장애·성적 지향", "성적인 묘사", "진단명을 사실처럼 붙이기", "자해·폭력을 부추기는 말"]) {
      expect(s).toContain(rule);
    }
    expect(s).toContain("멤버가 하지 않은 말을 그 사람의 말처럼");
    expect(s).toContain("지시의 리포트 구성 순서대로(인트로 종합 → 개인별 → 마무리) 쓴다");
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
      for (const ok of ["속마음·호감·연애 감정 추측", "호감·케미 점수와 순위", "놀림·별명·욕도 된다(틀려도 좋다)"]) expect(line).toContain(ok);
      for (const rule of ["따옴표 없이 인물의 말로", "지어낸 대사", "속성 비하·성적 묘사", "진단명 단정", "자해·폭력 부추김"]) expect(line).toContain(rule);
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

  it("말투마다 세 부분(인트로 종합 → 개인별 특징 → 마무리)을 순서대로 싣는다. 개인별은 사람마다 섹션 하나", () => {
    for (const t of PICKABLE_TONES) {
      for (const p of [hugePayload(t), payload("couple", t)]) {
        const body = instructionOf(buildRequest(p));
        expect(body).toContain(`리포트 구성(「${TONES[t].label}」의 형식이다. 세 부분을 이 순서로 쓴다. 섹션의 part는 앞의 키다):`);
        const { intro, people, others, outro } = reportParts(p);
        const heads = ["[1. 인트로 종합 리포트]", "[2. 개인별 특징 리포트]", "[3. 마무리 리포트]"].map((h) => body.indexOf(`\n${h} `));
        const at = (part: { key: string; title: string }) => body.indexOf(`\n- ${part.key} 「${part.title}」: `);
        const order = [heads[0], ...intro.map(at), heads[1], at(people), ...(others ? [at(others)] : []), heads[2], ...outro.map(at)];
        expect(order.every((i) => i >= 0), `${t}`).toBe(true);
        expect(order).toEqual([...order].sort((a, b) => a - b));
        // 개인별 구성이 정확히 하나
        expect(body.match(/\n- [a-z_]+ 「[^」]+」: 사람마다 섹션 하나\(about은 그 사람\)/g)).toHaveLength(1);
        expect(body).toContain(`목소리: 헤드라인과 첫 섹션 제목부터 마지막 문단까지 ${TONES[t].label}의 목소리와 형식으로 쓴다.`);
        expect(body).toContain(`사실을 설명하는 데서 멈추지 말고 ${TONES[t].label}의 관점에서 판정·해석을 내린다.`);
        // 개인별 머리말: 사람마다 그 인물의 판정이 하나 이상
        expect(body).toContain("사람마다 별명·역할 규정 같은 그 인물의 판정이 하나 이상 들어간다");
      }
    }
    // 개인별: 단톡 full은 문단 3~5개(적어도 3개, 잔소리 2~4개 + 인정 1), 1:1 full은 4~6개, small 단톡·1:1은 2~3개·3~4개
    const fact = instructionOf(buildRequest(hugePayload("fact")));
    expect(fact).toMatch(/- nag_cards 「사람별 잔소리 카드」: 사람마다 섹션 하나\(about은 그 사람\), 한 사람에 문단 3~5개\(적어도 3개\)\. [^\n]*잔소리 2~4개 \+ 인정 1[^\n]*근거 인용/);
    expect(instructionOf(buildRequest(longPair("fact")))).toMatch(/- nag_cards 「사람별 잔소리 카드」: [^\n]*문단 4~6개\(적어도 4개\)\. [^\n]*잔소리 3~5개 \+ 인정 1/);
    expect(instructionOf(buildRequest(bigPayload("fact")))).toMatch(/- nag_cards 「사람별 잔소리 카드」: [^\n]*문단 3~4개\(적어도 3개\)\. [^\n]*잔소리 2~3개 \+ 인정 1/);
    expect(instructionOf(buildRequest(payload("couple", "fact")))).toMatch(/- nag_cards 「사람별 잔소리 카드」: [^\n]*문단 3~4개\(적어도 3개\)/);
    // 인트로·마무리 섹션은 섹션 하나씩, 단계의 문단 수(full 3~4개)
    expect(fact).toContain("- nag_open 「첫 잔소리」: 섹션 하나, about은 group(1:1이면 pair), 문단 3~4개. ");
    expect(fact).toContain("- nag_last 「마지막 한마디」: 섹션 하나, about은 group(1:1이면 pair), 문단 3~4개. ");
    // 그 밖의 멤버: 섹션 하나에 한 사람 한 문단
    expect(fact).toContain("- nag_others 「그 밖의 멤버 한 줄 잔소리」: 섹션 하나, about은 group, 그다음 7~12위 많아야 6명을 한 사람에 문단 하나씩(문단 6개). ");
    expect(instructionOf(buildRequest(longPair("fact")))).not.toContain("nag_others");
    const show = instructionOf(buildRequest(payload("group", "show")));
    expect(show).toMatch(/- show_cast 「출연자 소개」: [^\n]*별명\(보이는 행동으로 지은 것\)과 캐치프레이즈/);
    // 캐치프레이즈는 실제로 되풀이한 말(큰따옴표 + 근거)이나 MC 자막뿐, 멤버 입에 지어낸 말을 넣지 않는다(Fix 3)
    expect(show).toMatch(/- show_cast [^\n]*캐치프레이즈는 그 사람이 실제로 되풀이한 말을 큰따옴표로 옮겨 근거로 달거나 MC 자막 \(자막: …\)으로 쓴다\. 안 한 말을 그 사람 입에 넣지 않는다\./);
    expect(show).toContain("그 사람이 실제로 되풀이한 말을 캐치프레이즈로 소개하고");
    expect(show).not.toContain("캐치프레이즈 한 줄로 소개");
    // small: 인트로·마무리 하나씩(VCR·시상식은 빠진다)
    expect(show).not.toContain("- show_vcr ");
    expect(instructionOf(buildRequest(hugePayload("show")))).toMatch(/- show_vcr 「하이라이트 VCR」: [^\n]*\(자막: …\)/);
    expect(instructionOf(buildRequest(hugePayload("show")))).toMatch(/- show_corner 「이 방 시상식」: [^\n]*수상자를 과감하게 정하고/);
    const detective = instructionOf(buildRequest(hugePayload("detective")));
    expect(detective).toMatch(/- case_open 「미해결 의문」: [^\n]*속마음·연애 감정까지 추리해도 된다/);
    expect(detective).toMatch(/- case_people 「관련자 프로필」: [^\n]*인상착의·외모는 적지 않는다/);
    expect(detective).toMatch(/- case_verdict 「수사 결론」: [^\n]*사건마다 범인을 지목해/);
    // 담임 선생님: 학생별 종합 의견은 사람마다 길게, 칭찬·응원과 고칠 점을 함께. 학급 개요로 시작해 담임의 편지로 끝난다
    const warm = instructionOf(buildRequest(hugePayload("warm")));
    expect(warm).toMatch(/- care_people 「학생별 종합 의견」: 사람마다 섹션 하나[^\n]*사람마다 길게[^\n]*칭찬·응원과 고칠 점을 함께 쓴다/);
    expect(warm).toMatch(/- care_open 「학급 개요」: /);
    expect(warm).toMatch(/- care_letter 「담임의 편지」: /);
    expect(warm).not.toContain("rec_");
  });

  it("마무리 구성(잔소리·편지·클로징)만 멤버를 이름으로 불러 말을 건다: '우리' 없이, 한쪽 편 없이, 질문으로 끝내지 않는다", () => {
    const closing = { fact: "nag_last", warm: "care_letter", show: "show_close" } as const;
    for (const [t, key] of Object.entries(closing)) {
      for (const p of [payload("couple", t as PickableTone), hugePayload(t as PickableTone)]) {
        const body = instructionOf(buildRequest(p));
        const line = body.split("\n").find((l) => l.startsWith(`- ${key} `))!;
        expect(line).toContain("이 섹션만 방 밖의 관찰자가 멤버들을 이름으로 불러");
        expect(line).toContain("'우리'로 쓰지 않는다");
        expect(line).toContain("한쪽 편을 들지 않고");
        expect(line).not.toContain("속마음도 대신 말하지 않으며");
        expect(line).toContain("마지막 판정(누구의 속마음이든 점수든)을 과감하게 못 박는다(틀려도 좋다)");
        expect(line).toContain("질문으로 끝내지 않는다");
        // 다른 구성에는 말 걸기 허용이 없다
        expect(body.split("이 섹션만 방 밖의 관찰자가").length).toBe(2);
      }
    }
    for (const t of ["docu", "detective"] as const) {
      expect(instructionOf(buildRequest(hugePayload(t)))).not.toContain("이 섹션만 방 밖의 관찰자가");
    }
  });

  it("분량 단계: 보낸 메시지 수로 small(<300)·medium(<1,500)·full을 고른다. 인용 상한은 30 이하, small은 인트로·마무리를 하나씩", () => {
    expect([VOLUME_SMALL_BELOW, VOLUME_FULL_FROM]).toEqual([300, 1500]);
    expect([0, 299, 300, 1499, 1500, 50_000].map(volumeTier)).toEqual(["small", "small", "medium", "medium", "full", "full"]);
    for (const v of Object.values(VOLUMES)) expect(v.quotes).toBeLessThanOrEqual(MAX_QUOTES_PER_REPORT);
    expect([VOLUMES.small.blockParts, VOLUMES.medium.blockParts, VOLUMES.full.blockParts]).toEqual([1, 2, 2]);
    expect([payload(), bigPayload(), hugePayload(), longPair()].map((p) => volumeTier(p.msgSent))).toEqual(["small", "medium", "full", "full"]);
  });

  it("분량·숫자 줄(full, v2.4): 섹션 수(인트로 + 개인별 + 마무리), 문단마다 4~7문장 250~400자(적어도 250자), 본문 10,000~13,000자(20,800자 이하), 인용 섹션마다 1~3개·30개, 마무리 몫 2개", () => {
    const closing = { fact: "nag_last", warm: "care_letter", show: "show_close", docu: "docu_outro", detective: "case_verdict" };
    for (const t of PICKABLE_TONES) {
      const body = instructionOf(buildRequest(longPair(t)));
      const outro = t === "fact" ? 1 : 2;
      expect(body).toContain(
        `분량: 리포트 전체 섹션 ${2 + 2 + outro}개(인트로 2 + 개인별 2 + 마무리 ${outro}). 섹션마다 문단 수는 구성 줄에 적힌 대로다. 문단 하나는 4~7문장, 250~400자다. 문단마다 적어도 250자를 쓴다: 한두 문장으로 짧게 끝내지 말고 장면 → 근거(인용) → 그 말투의 판정·리액션 → 앞뒤 흐름이나 다른 멤버의 반응을 이어서 한 문단을 채운다(예시가 문단 하나의 길이다). 본문(문단 글)은 리포트 전체 10,000~13,000자이고 20,800자를 넘기지 않는다. 근거 인용은 섹션마다 1~3개, 리포트 전체 30개 이하이고, 마지막 구성 ${closing[t]} 섹션 몫으로 2개를 남겨 둔다. reading_notes는 12개 이하.`,
      );
      expect(body).not.toContain("재료:");
      expect(body).toContain("숫자는 양념: 통계 자리표시자는 섹션마다 0~2개, 장면을 받쳐 줄 때만 쓴다. 숫자를 나열하지 않는다. 안 되는 예:");
      expect(body).toContain("사람마다 숫자를 줄줄이 대기");
      expect(body).toContain("문단마다 통계 하나를 읽고 해설하기");
    }
    // 40명 단톡: 인트로 2 + 개인별 6 + 그 밖의 멤버 1 + 마무리 2
    expect(instructionOf(buildRequest(hugePayload("show")))).toContain("분량: 리포트 전체 섹션 11개(인트로 2 + 개인별 7 + 마무리 2).");
  });

  it("분량(small·medium): 재료가 적은 대화는 분량을 줄이고, 구성 설명의 개수를 상한으로 보며 되풀이·지어내기로 채우지 않는다", () => {
    const small = instructionOf(buildRequest(payload()));
    expect(small).toContain(
      "분량: 리포트 전체 섹션 4개(인트로 1 + 개인별 2 + 마무리 1). 섹션마다 문단 수는 구성 줄에 적힌 대로다. 문단 하나는 4~7문장, 250~400자다.",
    );
    expect(small).toContain("본문(문단 글)은 리포트 전체 4,000~6,000자이고 12,000자를 넘기지 않는다. 근거 인용은 섹션마다 1~2개, 리포트 전체 14개 이하이고, 마지막 구성 nag_last 섹션 몫으로 2개를 남겨 둔다. reading_notes는 6개 이하.");
    expect(small).toContain("- nag_open 「첫 잔소리」: 섹션 하나, about은 group(1:1이면 pair), 문단 2~3개. ");
    expect(small).not.toContain("- nag_room ");
    expect(small).toContain("숫자는 양념: 통계 자리표시자는 섹션마다 0~1개");
    expect(small).toContain("재료: 보낸 대화가 6개로 많지 않다. 구성 설명에 적힌 개수(문단·잔소리·장면·상)는 상한으로 보고 대화에 있는 만큼만 쓴다.");
    expect(small).toContain("같은 장면·같은 인용을 되풀이하거나 없는 장면·대사를 지어내 분량을 채우지 않는다");
    const medium = instructionOf(buildRequest(bigPayload()));
    expect(medium).toContain("분량: 리포트 전체 섹션 10개(인트로 2 + 개인별 7 + 마무리 1).");
    expect(medium).toContain("- nag_open 「첫 잔소리」: 섹션 하나, about은 group(1:1이면 pair), 문단 2~3개. ");
    expect(medium).toContain("본문(문단 글)은 리포트 전체 7,000~10,000자이고 16,800자를 넘기지 않는다. 근거 인용은 섹션마다 1~3개, 리포트 전체 24개 이하");
    expect(medium).toContain("재료: 보낸 대화가 689개로 많지 않다.");
  });

  it("문단 합계(Fix 2·3, v2.4): 말투·단계마다 구성 줄이 시키는 최대 문단 수에 문단 글자 수 위쪽 끝을 곱해도 본문 상한 이하이고, full은 마감 어림 안이다", () => {
    // 지시 글에서 직접 읽는다: 분량 줄의 글자 수·본문 상한·섹션 수, 사람 줄의 사람 수, 구성 줄마다 섹션 수와 문단 수
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
    for (const [tier, make] of cases) {
      for (const t of PICKABLE_TONES) {
        const p = make(t);
        expect(volumeTier(p.msgSent)).toBe(tier);
        const body = instructionOf(buildRequest(p));
        const volume = /분량: 리포트 전체 섹션 (\d+)개[^\n]*?문단 하나는 \d+~\d+문장, (\d+~\d+)자다[^\n]*?([\d,]+)자를 넘기지 않는다/.exec(body)!;
        const [lo, hi] = volume[2].split("~").map(Number);
        const bodyCharsMax = Number(volume[3].replaceAll(",", ""));
        const persons = peopleShape(p).persons;
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
        expect(sections, `${tier} ${t} 섹션 수`).toBe(Number(volume[1]));
        expect(lo).toBeLessThan(hi);
        expect(paragraphs * hi, `${tier} ${t} ${paragraphs}문단 × ${hi}자`).toBeLessThanOrEqual(bodyCharsMax);
        // 마감 어림: 본문(위쪽 끝) + JSON + 생각 토큰이 (마감 − 첫 토큰 − 여유) × 출력 속도 안에 든다
        const e = DEADLINE_ESTIMATE;
        const outputTokens = paragraphs * hi * TOKENS_PER_CHAR + e.jsonTokens + e.thinkingTokens;
        const fits = (EPISODE_DEADLINE_MS / 1000 - e.ttftSec - e.marginSec) * e.outputTokensPerSec;
        expect(outputTokens, `${tier} ${t} 출력 ${outputTokens}토큰`).toBeLessThanOrEqual(fits);
      }
    }
  });

  it("마감 어림(v2.4 실측 반영): 출력 120 tok/s·첫 토큰 25초·생각 2,500토큰. full 위쪽 끝(20,800자)이 270초 안에 들고 출력 상한보다 작다", () => {
    expect(DEADLINE_ESTIMATE).toEqual({ outputTokensPerSec: 120, ttftSec: 25, marginSec: 15, jsonTokens: 3_200, thinkingTokens: 2_500 });
    // 실측(report-7): 8,973토큰 / (79초 − 첫 토큰 20초) ≈ 152 tok/s. 어림 속도는 그보다 낮다
    expect(DEADLINE_ESTIMATE.outputTokensPerSec).toBeLessThan(8_973 / (79 - 20));
    expect([PARAGRAPH_MIN, PARAGRAPH_MAX]).toEqual([250, 400]);
    expect(VOLUMES.full.bodyChars).toBe("10,000~13,000");
    const e = DEADLINE_ESTIMATE;
    const fits = (EPISODE_DEADLINE_MS / 1000 - e.ttftSec - e.marginSec) * e.outputTokensPerSec;
    expect(fits).toBe(27_600);
    // 본문 위쪽 끝: full 인트로 2 × 4 + 개인별 6 × 5 + 그 밖의 6 × 1 + 마무리 2 × 4 = 52문단 × 400자 = bodyCharsMax
    const bodyMax = Number(VOLUMES.full.bodyCharsMax.replaceAll(",", ""));
    const block = max(VOLUMES.full.blockParagraphs);
    expect(bodyMax).toBe((2 * block + PEOPLE_CAP * max(VOLUMES.full.peopleParagraphs) + 6 + 2 * block) * PARAGRAPH_MAX);
    const upper = bodyMax * TOKENS_PER_CHAR + e.jsonTokens + e.thinkingTokens;
    expect(upper).toBe(26_500);
    expect(upper).toBeLessThanOrEqual(fits);
    // 전체 시간(첫 토큰 + 출력)이 마감 − 여유 안
    expect(e.ttftSec + upper / e.outputTokensPerSec).toBeLessThanOrEqual(EPISODE_DEADLINE_MS / 1000 - e.marginSec);
    // 출력 상한은 위쪽 끝보다 커서 리포트를 먼저 자르지 않는다(실제 한계는 마감)
    expect(DEFAULT_REPORT_MAX_TOKENS).toBeGreaterThanOrEqual(upper);
    // 단계마다 목표 위쪽 끝은 상한 이하다
    for (const v of Object.values(VOLUMES)) {
      const [lo, hi] = v.bodyChars.split("~").map((x) => Number(x.replaceAll(",", "")));
      expect(lo).toBeLessThan(hi);
      expect(hi).toBeLessThan(Number(v.bodyCharsMax.replaceAll(",", "")));
    }
    // 작은 대화는 비례해서 짧다
    const his = (["small", "medium", "full"] as const).map((t) => Number(VOLUMES[t].bodyChars.split("~")[1].replaceAll(",", "")));
    expect(his).toEqual([...his].sort((a, b) => a - b));
    function max(range: string) {
      return Number(range.split("~")[1]);
    }
  });

  it("couple 지시: 방·참여자 수, 연애·썸 소재(한쪽 편 없이, 판정은 대화 습관에만), 1:1은 두 사람 중심", () => {
    const body = instructionOf(buildRequest(longPair()));
    expect(body).toContain("방: 1:1 · 참여자 2명(<members>의 범례)");
    expect(body).toMatch(/소재\(연애·썸\): [^\n]*stats\.crossed는 그대로 묘사하고[^\n]*한쪽 편을 들지 않되[^\n]*앞날은 그 인물의 관점에서 과감하게 점쳐도 된다/);
    expect(body).toContain(
      "사람: 1:1 두 사람이다. 같은 형식에서 두 사람 중심으로 쓴다. nag_cards 「사람별 잔소리 카드」에서는 두 사람 각자 섹션 하나씩 깊게 쓰고, 인트로 종합과 마무리는 about을 pair로 두고 두 사람 사이에 오간 것을 쓴다.",
    );
    expect(body).not.toContain("철수");
    expect(body).not.toContain("민지");
    // 같은 말투면 컨셉이 달라도 구성은 같다(방 종류는 소재만 정한다)
    const parts = (b: string) => b.split("\n").filter((l) => l.startsWith("- "));
    // (같은 분량 단계끼리 본다: 개인별의 문단 수는 단계마다 다르다)
    expect(parts(instructionOf(buildRequest(payload("group"))))).toEqual(parts(instructionOf(buildRequest(payload("couple")))));
  });

  it("group 지시: 단톡 소재, 참여자가 적으면 모두 섹션 하나씩, 많으면 상위 6명만 길게, 그다음 순위는 그 밖의 멤버 섹션에서 한 문단씩", () => {
    const body = instructionOf(buildRequest(payload("group")));
    expect(body).toContain("방: 단톡방 · 참여자 2명(<members>의 범례)");
    expect(body).toMatch(/소재\(친구·가족 단톡방\): [^\n]*명장면/);
    const three = buildPayload({ messages: syntheticGroupChat(3, 2), tone: "warm", concept: "group", kind: "group", tokenBudget: 1_000_000, tokensPerChar: 1 });
    expect(instructionOf(buildRequest(three))).toContain("사람: 참여자 3명 모두 care_people 「학생별 종합 의견」에서 한 사람에 섹션 하나씩 쓴다.");
    // full: 상위 6명만 섹션, 그다음 7~12위(<stats>에 있는 12명 안) 많아야 6명은 그 밖의 멤버 섹션에서 한 문단씩, 그 아래는 이름 없이 한 문장
    const huge = instructionOf(buildRequest(hugePayload()));
    expect(huge).toContain(
      "사람: 메시지가 많은 상위 6명(<stats>의 byPerson 순서)만 nag_cards 「사람별 잔소리 카드」에서 한 사람에 섹션 하나씩 길게 쓴다. 그다음 7~12위 많아야 6명은 nag_others 「그 밖의 멤버 한 줄 잔소리」 섹션 하나에서 한 사람에 문단 하나씩 다룬다. <conversation>에 그 사람의 줄이 없으면 건너뛴다. 그 밖의 멤버는 이름을 부르지 않고 '나머지 멤버들'처럼 한 문장으로 묶는다. 줄이 없는 멤버를 짐작으로 묘사하지 않는다.",
    );
    expect(instructionOf(buildRequest(hugePayload("detective")))).toContain(
      "사람: 메시지가 많은 상위 6명(<stats>의 byPerson 순서)만 case_people 「관련자 프로필」에서 한 사람에 섹션 하나씩 길게 쓴다. 그다음 7~12위 많아야 6명은 case_others 「그 밖의 관련자」",
    );
    // 한 문단을 받는 사람은 모두 <stats>(12명)에 있다
    for (const t of PICKABLE_TONES) {
      const m = /그다음 (\d+)~(\d+)위 많아야 (\d+)명은/.exec(instructionOf(buildRequest(hugePayload(t))))!;
      expect(Number(m[2])).toBeLessThanOrEqual(PROMPT_STATS_MAX_PEOPLE);
      expect(Number(m[3])).toBeLessThanOrEqual(6);
    }
    // 8명 단톡(실측 방과 같은 크기): 6명 섹션 + 2명은 그 밖의 멤버에서 한 문단씩
    const eight = buildPayload({ messages: syntheticGroupChat(8, 60), tone: "show", concept: "group", kind: "group", tokenBudget: 200_000, tokensPerChar: 1 });
    expect(instructionOf(buildRequest(eight))).toContain("- show_others 「그 밖의 출연자」: 섹션 하나, about은 group, 그다음 7~8위 많아야 2명을 한 사람에 문단 하나씩(문단 2개). ");
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
    expect(ten).toContain(
      "사람: 참여자 10명 중 <conversation>에 줄이 있는 3명만 nag_cards 「사람별 잔소리 카드」에서 한 사람에 섹션 하나씩 쓴다. 나머지 멤버는 이름을 부르지 않고 짐작으로 묘사하지 않는다.",
    );
    expect(ten).not.toContain("nag_others");
    // 참여자가 섹션 수 이하인데 그중 말하지 않은 사람이 있으면 섹션을 만들지 않게 알린다
    const four = { ...quiet, members: [...quiet.members, "조용0"] };
    expect(instructionOf(buildRequest(four))).toContain(
      "사람: 참여자 4명 모두 nag_cards 「사람별 잔소리 카드」에서 한 사람에 섹션 하나씩 쓴다. <conversation>에 줄이 없는 멤버는 섹션을 만들지 않고 짐작으로 묘사하지 않는다.",
    );
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
    const reqs = PICKABLE_TONES.flatMap((t) => [
      buildRequest(payload("couple", t)),
      buildRequest(payload("group", t)),
      buildRequest(bigPayload(t)),
      buildRequest(hugePayload(t)),
      buildRequest(longPair(t)),
    ]);
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
