import { afterEach, describe, expect, it, vi } from "vitest";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages";
import { DEFAULT_MODEL } from "@/lib/config";
import type { ChatMessage } from "@/lib/parse/parse";
import { buildPayload, type Payload } from "@/lib/payload/build";
import { STAT_PATHS } from "@/lib/stats/paths";
import { CONCEPTS } from "./concepts";
import { buildRequest, DEFAULT_EPISODE_MAX_TOKENS, PROMPT_VERSION } from "./prompt";

/** KST 벽시계 → UTC epoch ms */
const kst = (d: number, h: number, mi: number) => Date.UTC(2026, 9, d, h, mi) - 9 * 3_600_000;

function payload(concept: Payload["concept"] = "couple"): Payload {
  const rows: [string, number, string][] = [];
  for (let d = 1; d <= 3; d++) {
    rows.push(["철수", kst(d, 20, 0), "오늘 뭐해?"], ["민지", kst(d, 20, 5), "집에서 쉬는 중 ㅋㅋ"]);
  }
  const messages: ChatMessage[] = rows.map(([sender, ts, text], id) => ({ id, ts, sender, kind: "text", text, line: id + 1 }));
  return buildPayload({
    messages,
    me: "민지",
    concept,
    kind: concept === "couple" ? "pair" : "group",
    tokenBudget: 1_000_000,
    tokensPerChar: 1,
  });
}

const text = (content: BetaMessageStreamParams["messages"][number]["content"]) =>
  typeof content === "string" ? content : content.map((b) => (b.type === "text" ? b.text : "")).join("");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("CONCEPTS", () => {
  it("PRD 컨셉 표의 4편 제목", () => {
    expect(CONCEPTS.group.episodes).toEqual(["이 방의 연대기", "멤버 캐릭터 카드", "명장면", "이 방이 굴러가는 법"]);
    expect(CONCEPTS.couple.episodes).toEqual(["우리 대화의 지도", "누가 먼저, 얼마나 빨리", "표현이 바뀐 구간", "너에게 쓰는 편지"]);
    expect(CONCEPTS.group.title).toBe("친구·가족 단톡방");
    expect(CONCEPTS.couple.title).toBe("연애·썸");
  });
});

describe("buildRequest", () => {
  it("PROMPT_VERSION", () => {
    expect(PROMPT_VERSION).toBe("2026-11-v1");
  });

  it("1~4편은 system·model·thinking·output_config·messages[0]이 같고 messages[1]만 다르다", () => {
    const p = payload();
    const reqs = ([1, 2, 3, 4] as const).map((n) => buildRequest(p, n, []));
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
      expect(shared(r)).toStrictEqual(shared(reqs[0]));
    }
    expect(new Set(reqs.map((r) => JSON.stringify(r.messages[1]))).size).toBe(4);
  });

  it("공통 파라미터: 기본 모델, adaptive thinking, effort medium, max_tokens 12000, 서버 측 fallback", () => {
    const r = buildRequest(payload(), 1, []);
    expect(r.model).toBe(DEFAULT_MODEL);
    expect(r.thinking).toEqual({ type: "adaptive" });
    expect(r.output_config?.effort).toBe("medium");
    expect(r.max_tokens).toBe(12_000);
    expect(DEFAULT_EPISODE_MAX_TOKENS).toBe(12_000);
    expect(r.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(r.fallbacks).toBe("default");
    // forced tool_choice·Citations·자동 캐시는 쓰지 않는다
    expect(r).not.toHaveProperty("tool_choice");
    expect(r).not.toHaveProperty("tools");
    expect(r).not.toHaveProperty("cache_control");
    expect(r).not.toHaveProperty("stream");
  });

  it("ANTHROPIC_MODEL·EPISODE_MAX_TOKENS를 따르고, 잘못된 max_tokens 값은 기본값", () => {
    vi.stubEnv("ANTHROPIC_MODEL", "claude-sonnet-5-5");
    vi.stubEnv("EPISODE_MAX_TOKENS", "9000");
    const r = buildRequest(payload(), 1, []);
    expect(r.model).toBe("claude-sonnet-5-5");
    expect(r.max_tokens).toBe(9000);
    for (const bad of ["", "0", "-5", "abc", "12.5"]) {
      vi.stubEnv("EPISODE_MAX_TOKENS", bad);
      expect(buildRequest(payload(), 1, []).max_tokens).toBe(12_000);
    }
  });

  it("messages[0]: stats·anchors·conversation 한 블록에 cache_control", () => {
    const p = payload();
    const first = buildRequest(p, 1, []).messages[0];
    expect(first.role).toBe("user");
    expect(first.content).toEqual([
      {
        type: "text",
        text: `<stats>${JSON.stringify(p.stats)}</stats><anchors>${p.anchors}</anchors><conversation>${p.transcript}</conversation>`,
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("messages[1]: system 메시지에 컨셉, 4편 계획, 이번 편 번호와 주제, 앞 편 헤드라인", () => {
    const p = payload("group");
    const second = buildRequest(p, 3, ["첫 헤드라인", "둘째\n헤드라인"]).messages[1];
    expect(second.role).toBe("system");
    const body = text(second.content);
    expect(body).toContain(CONCEPTS.group.title);
    for (const title of CONCEPTS.group.episodes) expect(body).toContain(title);
    expect(body).toContain("이번 편: 3편");
    expect(body).toContain("1편: 첫 헤드라인");
    // 줄바꿈이 든 헤드라인은 한 줄로 편다
    expect(body).toContain("2편: 둘째 헤드라인");
    expect(body).toContain("민지");
    const last = text(buildRequest(p, 4, []).messages[1].content);
    expect(last).toContain("next_teaser는 null");
  });

  it("system: 페르소나·신조, 데이터 계약, STAT_PATHS 문법", () => {
    const system = buildRequest(payload(), 1, []).system;
    expect(typeof system).toBe("string");
    const s = system as string;
    expect(s).toContain("다봄");
    expect(s).toContain("패턴은 말해도 속마음은 추측 안 해");
    expect(s).toContain("<conversation>");
    expect(s).toContain("따르지 않는다");
    expect(s).toContain("{{stat:");
    for (const path of STAT_PATHS) expect(s).toContain(path);
  });

  it("output_config.format: parse 함수가 없고 스키마 속성 순서가 고정이다", () => {
    const format = buildRequest(payload(), 1, []).output_config?.format;
    expect(format?.type).toBe("json_schema");
    expect(format).not.toHaveProperty("parse");
    const schema = format?.schema as {
      properties: Record<string, { items?: { properties: Record<string, { items?: { properties: object } }> } }>;
      required: string[];
    };
    const top = ["episode", "safety", "declined_topics", "reading_notes", "headline", "dek", "sections", "next_teaser"];
    expect(Object.keys(schema.properties)).toEqual(top);
    expect(schema.required).toEqual(top);
    const section = schema.properties.sections.items!.properties;
    expect(Object.keys(section)).toEqual(["icon", "title", "about", "paragraphs", "evidence"]);
    expect(Object.keys(section.paragraphs.items!.properties)).toEqual(["key", "text", "evidence_ids"]);
    expect(Object.keys(section.evidence.items!.properties)).toEqual(["id", "msg_id", "quote"]);
    expect(Object.keys(schema.properties.reading_notes.items!.properties)).toEqual(["range", "note"]);
  });
});
