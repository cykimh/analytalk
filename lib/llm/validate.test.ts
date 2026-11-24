import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/lib/parse/parse";
import { buildPayload, payloadIndex } from "@/lib/payload/build";
import { resolveStat } from "@/lib/stats/paths";
import type { Episode } from "./schema";
import { validateEpisode } from "./validate";

/** KST 벽시계 → UTC epoch ms */
const kst = (d: number, h: number, mi: number) => Date.UTC(2026, 9, d, h, mi) - 9 * 3_600_000;

/** 2026-10-01~03 저녁마다 철수·민지(표시 이름)가 네 번 주고받는 대화. id는 0부터, 하루 4개 */
function fixture(other = "철수", me = "민지") {
  const rows: [string, number, string][] = [];
  for (let d = 1; d <= 3; d++) {
    rows.push(
      [other, kst(d, 20, 0), "오늘 뭐해?"],
      [me, kst(d, 20, 5), "집에서 쉬는 중 ㅋㅋ"],
      [other, kst(d, 20, 6), "영화 볼래?\n내일 저녁"],
      [me, kst(d, 20, 10), "좋아!"],
    );
  }
  const messages: ChatMessage[] = rows.map(([sender, ts, text], id) => ({ id, ts, sender, kind: "text", text, line: id + 1 }));
  const p = buildPayload({ messages, me, concept: "couple", kind: "pair", tokenBudget: 1_000_000, tokensPerChar: 1 });
  return { idx: payloadIndex(p), stats: p.stats };
}
const { idx, stats } = fixture();

type Section = Episode["sections"][number];
type Paragraph = Section["paragraphs"][number];
const para = (key: string, text: string, evidence_ids: string[] = []): Paragraph => ({ key, text, evidence_ids });
const ev = (id: string, msg_id: string, quote: string) => ({ id, msg_id, quote });
const sec = (title: string, paragraphs: Paragraph[], evidence: Section["evidence"] = [], about = "pair"): Section => ({
  icon: "🌙",
  title,
  about,
  paragraphs,
  evidence,
});
const episode = (sections: Section[], extra: Partial<Episode> = {}): Episode => ({
  episode: 1,
  safety: { flag: "none" },
  declined_topics: [],
  reading_notes: [{ range: "10-01~10-03", note: "사흘 동안 저녁마다 이야기했다" }],
  headline: "저녁 8시의 대화",
  dek: "사흘 동안의 흐름",
  sections,
  next_teaser: "다음 편: 누가 먼저",
  ...extra,
});
const run = (raw: unknown, truncated = false) => validateEpisode(raw, idx, stats, { truncated });

describe("validateEpisode", () => {
  it("정상이면 done이고 근거에 sender·at이 채워진다", () => {
    const raw = episode([
      sec("저녁의 리듬", [para("p1", "민지는 저녁마다 짧게 답했어요", ["e1"])], [ev("e1", "m1", "쉬는 중")]),
    ]);
    const r = run(raw);
    expect(r.status).toBe("done");
    expect(r.dropped).toEqual({ paragraphs: 0, evidence: 0 });
    expect(r.content?.sections[0].evidence).toEqual([
      { id: "e1", msg_id: "m1", quote: "쉬는 중", sender: "민지", at: "2026-10-01T20:05:00+09:00" },
    ]);
    expect(r.content?.headline).toBe("저녁 8시의 대화");
    expect(r.content?.reading_notes).toEqual(raw.reading_notes);
  });

  it("없는 msg_id·본문과 다른 quote·빈 quote는 근거에서 지운다", () => {
    const r = run(
      episode([
        sec(
          "근거 검사",
          [para("p1", "저녁에 대화가 몰려요", ["e1", "e2", "e3", "e4"])],
          [ev("e1", "m999", "쉬는 중"), ev("e2", "m1", "쉬는중"), ev("e3", "m1", " "), ev("e4", "m1", "집에서")],
        ),
      ]),
    );
    expect(r.content?.sections[0].evidence.map((e) => e.id)).toEqual(["e4"]);
    expect(r.content?.sections[0].paragraphs[0].evidence_ids).toEqual(["e4"]);
    expect(r.dropped).toEqual({ paragraphs: 0, evidence: 3 });
  });

  it("줄바꿈(⏎)이 든 본문은 줄바꿈으로 비교하고 저장한다", () => {
    const r = run(
      episode([
        sec(
          "영화",
          [para("p1", "철수가 영화를 제안했어요", ["e1", "e2"])],
          [ev("e1", "m2", "영화 볼래?\n내일"), ev("e2", "m6", "볼래? ⏎ 내일 저녁")],
        ),
      ]),
    );
    expect(r.content?.sections[0].evidence.map((e) => e.quote)).toEqual(["영화 볼래?\n내일", "볼래?\n내일 저녁"]);
  });

  it("금지 문장이 든 문단은 지운다", () => {
    const r = run(
      episode([
        sec("마음", [para("p1", "저녁에 대화가 몰려요"), para("p2", "철수는 속마음은 분명 민지를 좋아해요"), para("p3", "주말엔 조용해요")]),
      ]),
    );
    expect(r.content?.sections[0].paragraphs.map((p) => p.key)).toEqual(["p1", "p3"]);
    expect(r.dropped.paragraphs).toBe(1);
    expect(r.status).toBe("partial"); // 3개 중 1개 = 33%
  });

  it("10개 중 4개가 지워지면 partial", () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) =>
      para(`p${i + 1}`, i < 4 ? `연락할 확률이 높아요 ${i}` : `저녁 대화가 이어져요 ${i}`),
    );
    const r = run(episode([sec("열 문단", paragraphs)]));
    expect(r.status).toBe("partial");
    expect(r.dropped.paragraphs).toBe(4);
    expect(r.content?.sections[0].paragraphs).toHaveLength(6);
  });

  it("10개 중 2개만 지워지면 done", () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) =>
      para(`p${i + 1}`, i < 2 ? `애정 지수가 올랐어요 ${i}` : `저녁 대화가 이어져요 ${i}`),
    );
    expect(run(episode([sec("열 문단", paragraphs)])).status).toBe("done");
  });

  it("{{stat:경로}}: 풀리는 경로는 유지, 없는 경로·모르는 자리표시자는 문단 제거", () => {
    expect(resolveStat("monthly.2026-10.replyMedianMs.민지", stats)).not.toBeNull();
    const r = run(
      episode([
        sec("숫자", [
          para("p1", "민지의 10월 답장 간격은 {{stat:monthly.2026-10.replyMedianMs.민지}}였어요"),
          para("p2", "민지의 9월 답장 간격은 {{stat:monthly.2026-09.replyMedianMs.민지}}였어요"),
          para("p3", "대화는 모두 {{stat:total}}개예요 {{name}}"),
          para("p4", "철수는 {{stat:byPerson.영희}}개"),
        ]),
      ]),
    );
    expect(r.content?.sections[0].paragraphs.map((p) => p.key)).toEqual(["p1"]);
  });

  it("근거가 모두 지워진 사람 문단은 지우고, 사람이 아닌 문단은 근거 없이 남긴다", () => {
    const r = run(
      episode([
        sec(
          "근거",
          [
            para("p1", "철수는 늘 먼저 물었어요", ["e1"]),
            para("p2", "저녁 8시에 대화가 몰려요", ["e1"]),
            para("p3", "답장이 오가는 속도가 비슷해요", ["e2"]),
          ],
          [ev("e1", "m999", "없는 메시지"), ev("e2", "m3", "좋아!")],
        ),
      ]),
    );
    const kept = r.content?.sections[0].paragraphs;
    expect(kept?.map((p) => [p.key, p.evidence_ids])).toEqual([
      ["p2", []],
      ["p3", ["e2"]],
    ]);
  });

  it("about이 사람인 섹션은 근거나 자리표시자가 있어야 남는다", () => {
    const r = run(
      episode([
        sec(
          "민지",
          [
            para("p1", "저녁마다 짧게 답했어요"),
            para("p2", "답장은 {{stat:replyMedianMs.민지}} 안에 왔어요"),
            para("p3", "웃음이 많아요", ["e1"]),
          ],
          [ev("e1", "m1", "ㅋㅋ")],
          "민지",
        ),
        sec("나", [para("p1", "질문을 자주 했어요")], [], "me"),
      ]),
    );
    expect(r.content?.sections).toHaveLength(1);
    expect(r.content?.sections[0].paragraphs.map((p) => p.key)).toEqual(["p2", "p3"]);
  });

  it("근거는 편 전체에서 8개까지, 앞 섹션부터 센다", () => {
    const evidence = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => ev(`${prefix}${i + 1}`, `m${i}`, idx.get(`m${i}`)!.text.split(" ⏎ ")[0]));
    const r = run(
      episode([
        sec("앞", [para("p1", "저녁 대화가 이어져요")], evidence("a", 5)),
        sec("뒤", [para("p1", "주말 대화가 길어요")], evidence("b", 5)),
      ]),
    );
    expect(r.content?.sections[0].evidence).toHaveLength(5);
    expect(r.content?.sections[1].evidence.map((e) => e.id)).toEqual(["b1", "b2", "b3"]);
    expect(r.dropped.evidence).toBe(2);
  });

  it("문단이 모두 지워진 섹션은 빠지고 근거 몫을 쓰지 않는다", () => {
    const r = run(
      episode([
        sec("지워짐", [para("p1", "호감도 90")], [ev("e1", "m1", "쉬는 중")]),
        sec("남음", [para("p1", "저녁 대화가 이어져요")], [ev("e1", "m1", "집에서")]),
      ]),
    );
    expect(r.content?.sections.map((s) => s.title)).toEqual(["남음"]);
    expect(r.dropped).toEqual({ paragraphs: 1, evidence: 1 });
  });

  it("headline·dek·섹션 제목·next_teaser·reading_notes의 금지 표현은 비운다", () => {
    const r = run(
      episode([sec("MBTI로 본 둘", [para("p1", "저녁 대화가 이어져요")])], {
        headline: "애정 지수 리포트",
        dek: "확률로 보는 마음",
        next_teaser: "다음 편: 우울증 신호",
        reading_notes: [
          { range: "10-01", note: "관심이 있는 것 같다" },
          { range: "10-02", note: "저녁 대화" },
        ],
      }),
    );
    expect(r.content?.headline).toBe("");
    expect(r.content?.dek).toBe("");
    expect(r.content?.next_teaser).toBe("");
    expect(r.content?.sections[0].title).toBe("");
    expect(r.content?.reading_notes).toEqual([{ range: "10-02", note: "저녁 대화" }]);
    expect(r.status).toBe("done");
  });

  it("모델 글의 개인정보(전화·링크·계좌·이메일)를 다시 검사한다: 문단은 지우고 headline·dek·제목·예고·메모는 비운다 (PRD 5장 6)", () => {
    const r = run(
      episode(
        [
          sec("010-1234-5678로 연락", [
            para("p1", "저녁 대화가 이어져요"),
            para("p2", "번호는 010-9999-8888이에요"),
            para("p3", "minji@example.com으로 보냈어요"),
          ]),
        ],
        {
          headline: "010-1234-5678의 비밀",
          dek: "https://example.com/x 에서 시작",
          next_teaser: "다음 편: 110-123-456789 계좌",
          reading_notes: [
            { range: "10-01", note: "instagram.com/minji 링크" },
            { range: "10-02", note: "저녁 대화" },
          ],
        },
      ),
    );
    expect(r.content?.headline).toBe("");
    expect(r.content?.dek).toBe("");
    expect(r.content?.next_teaser).toBe("");
    expect(r.content?.sections[0].title).toBe("");
    expect(r.content?.sections[0].paragraphs.map((p) => p.key)).toEqual(["p1"]);
    expect(r.content?.reading_notes).toEqual([{ range: "10-02", note: "저녁 대화" }]);
    expect(r.dropped.paragraphs).toBe(2);
  });

  // 표시 이름이 링크 끝과 같은 영어 낱말(Me·Com …)이어도 풀리는 자리표시자는 개인정보 검사에서 뺀다 (N1)
  it("풀리는 {{stat:…}} 자리표시자 속 표시 이름(Me·Com)은 링크로 보지 않는다. 자리표시자 밖의 개인정보는 그대로 지운다", () => {
    const f = fixture("Com", "Me");
    const r = validateEpisode(
      episode(
        [
          sec("{{stat:byPerson.Me}}개의 메시지", [
            para("p1", "메시지 {{stat:byPerson.Me}}개"),
            para("p2", "10월엔 {{stat:monthly.2026-10.count.Me}}개, 상대는 {{stat:byPerson.Com}}개"),
            para("p3", "{{stat:byPerson.Me}}개, 번호는 010-9999-8888이에요"),
            para("p4", "{{stat:byPerson.Com}}개, minji.github.io 블로그"),
          ]),
        ],
        { headline: "{{stat:share.Me}}만큼 먼저", dek: "{{stat:byPerson.Com}}개의 답장" },
      ),
      f.idx,
      f.stats,
      { truncated: false },
    );
    expect(r.content?.sections[0].paragraphs.map((p) => p.key)).toEqual(["p1", "p2"]);
    expect(r.content?.sections[0].title).toBe("{{stat:byPerson.Me}}개의 메시지");
    expect(r.content?.headline).toBe("{{stat:share.Me}}만큼 먼저");
    expect(r.content?.dek).toBe("{{stat:byPerson.Com}}개의 답장");
  });

  it("풀리지 않는 자리표시자 속 개인정보는 숨지 않는다: 제목·headline을 비운다", () => {
    const r = run(
      episode([sec("{{stat:010-1234-5678}} 연락", [para("p1", "저녁 대화가 이어져요")])], {
        headline: "{{minji@example.com}}",
      }),
    );
    expect(r.content?.sections[0].title).toBe("");
    expect(r.content?.headline).toBe("");
  });

  it("가린 표시([가림:…])가 든 인용·문단은 개인정보로 보지 않는다", () => {
    const r = run(episode([sec("가린 것", [para("p1", "[가림:전화]를 주고받았어요")])]));
    expect(r.content?.sections[0].paragraphs).toHaveLength(1);
  });

  it("글자 수를 맞춘다: 너무 긴 headline·dek·제목·예고는 비우고, 너무 긴 문단은 지운다 (PRD 5장 1)", () => {
    const r = run(
      episode([sec("가".repeat(61), [para("p1", "저녁 대화가 이어져요"), para("p2", "나".repeat(801))])], {
        headline: "다".repeat(81),
        dek: "라".repeat(201),
        next_teaser: "마".repeat(121),
      }),
    );
    expect(r.content?.headline).toBe("");
    expect(r.content?.dek).toBe("");
    expect(r.content?.next_teaser).toBe("");
    expect(r.content?.sections[0].title).toBe("");
    expect(r.content?.sections[0].paragraphs.map((p) => p.key)).toEqual(["p1"]);
  });

  it("icon은 이모지 몇 글자만(글자·숫자가 들면 비운다), about은 me·pair·group·참여자 이름만(아니면 group)", () => {
    const r = run(
      episode([
        { ...sec("하나", [para("p1", "저녁 대화가 이어져요")]), icon: "철수는 분명 좋아해요", about: "아무 말" },
        { ...sec("둘", [para("p1", "메시지 {{stat:byPerson.민지}}개")]), icon: "👨‍👩‍👧", about: "민지" },
        { ...sec("셋", [para("p1", "메시지 {{stat:byPerson.민지}}개")]), icon: "🌙", about: "me" },
      ]),
    );
    expect(r.content?.sections.map((x) => [x.icon, x.about])).toEqual([
      ["", "group"],
      ["👨‍👩‍👧", "민지"],
      ["🌙", "me"],
    ]);
  });

  it("모르는 declined_topics 값은 버리고 편은 살린다(SDK 스키마 변환이 enum을 강제하지 않는다)", () => {
    const raw = { ...episode([sec("s", [para("p1", "저녁 대화가 이어져요")])]), declined_topics: ["health", "money", 3] };
    const r = run(raw);
    expect(r.status).toBe("done");
    expect(r.content?.declined_topics).toEqual(["health"]);
  });

  it("safety.flag가 none이 아니면 safety", () => {
    const r = run(episode([sec("s", [para("p1", "저녁 대화")])], { safety: { flag: "self_harm" } }));
    expect(r).toEqual({ status: "safety", content: null, dropped: { paragraphs: 0, evidence: 0 } });
  });

  it("표에 없는 none 아닌 flag도 safety (SDK 스키마 변환이 enum을 강제하지 않는다)", () => {
    for (const flag of ["unknown", "self-harm", "자해", ""]) {
      const r = run(episode([sec("s", [para("p1", "저녁 대화")])], { safety: { flag: flag as "none" } }));
      expect(r, flag).toEqual({ status: "safety", content: null, dropped: { paragraphs: 0, evidence: 0 } });
    }
  });

  it("safety가 걸린 응답은 다른 필드가 구조 검사에 맞지 않아도 safety", () => {
    const flagged = { safety: { flag: "violence" } };
    // episode 범위 밖(min·max도 API가 강제하지 않는다)
    expect(run({ ...episode([sec("s", [para("p1", "저녁 대화")])]), ...flagged, episode: 7 }).status).toBe("safety");
    // 뒤쪽 필드가 없다(truncated 아님)
    expect(run({ episode: 1, ...flagged }).status).toBe("safety");
    expect(run({ ...flagged, sections: "x" }, true).status).toBe("safety");
  });

  it("flag의 대소문자·앞뒤 공백은 무시한다: ' None '은 none", () => {
    const r = run(episode([sec("s", [para("p1", "저녁 대화가 이어져요")])], { safety: { flag: " None " as "none" } }));
    expect(r.status).toBe("done");
    expect(r.content?.safety).toEqual({ flag: "none" });
  });

  it("구조가 틀리면 failed, 완결 섹션이 0개여도 failed", () => {
    expect(run({ episode: 1 }).status).toBe("failed");
    expect(run("not json").status).toBe("failed");
    // flag가 문자열이 아니면 safety 판정을 할 수 없다
    expect(run(episode([sec("s", [para("p1", "저녁 대화")])], { safety: { flag: 3 as unknown as "none" } })).status).toBe("failed");
    expect(run({ ...episode([sec("s", [para("p1", "저녁 대화")])]), safety: null }).status).toBe("failed");
    expect(run(episode([])).status).toBe("failed");
    expect(run(episode([sec("s", [para("p1", "확률 99")])])).content).toBeNull();
  });

  it("truncated: 빠진 뒤쪽 필드에 기본값을 넣고, 결과는 partial", () => {
    const raw: Partial<Episode> = episode([sec("s", [para("p1", "저녁 대화가 이어져요")])]);
    delete raw.next_teaser;
    expect(run(raw).status).toBe("failed");
    const r = run(raw, true);
    expect(r.status).toBe("partial");
    expect(r.content?.next_teaser).toBeNull();
    const head = { episode: 2, safety: { flag: "none" as const }, declined_topics: [] };
    expect(run(head, true).status).toBe("failed"); // 섹션 0개
    expect(run({ episode: 2 }, true).status).toBe("failed"); // safety 없음
    expect(run(null, true).status).toBe("failed");
  });
});
