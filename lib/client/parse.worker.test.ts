import { readFileSync } from "node:fs";
import { BlobWriter, TextReader, ZipWriter } from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";
import { FALLBACK_INPUT_TOKEN_BUDGET, TOKENS_PER_CHAR } from "@/lib/config";
import { buildPayload, buildPayloadForBudget } from "@/lib/payload/build";
import type { ChatMessage } from "@/lib/parse/parse";
import { handleMessage, type RenameInput, runOp } from "./parse.worker";

const fixture = readFileSync(new URL("../../test/fixtures/android-ko.txt", import.meta.url), "utf8").replace(/^\uFEFF(?:# .*\r?\n)+/, "\uFEFF");
const chatFile = (name = "KakaoTalkChats.txt") => new File([fixture], name);

const msg = (id: number, sender: string | null, text: string, kind: ChatMessage["kind"] = "text"): ChatMessage => ({
  id,
  ts: Date.UTC(2024, 2, 14, 3, id),
  sender,
  kind: sender === null ? "system" : kind,
  text,
  line: id + 1,
});

const rename = (over: Partial<RenameInput> = {}): RenameInput => ({
  messages: [msg(0, "김민지", "철수야 밥 먹자"), msg(1, "철수", "민지수 왔어"), msg(2, "철수", "응")],
  map: { 김민지: "민지", 철수: "철수" },
  merged: [],
  excluded: [],
  ...over,
});

describe("runOp parse", () => {
  it("txt를 읽어 parseExport 결과를 돌려준다", async () => {
    const r = await runOp({ op: "parse", files: [chatFile()] });
    expect(r).toMatchObject({ formatId: "android-ko", recognizedRatio: 1, participants: ["민지", "철수", "민지, 수아", "영희"] });
    expect((r as { messages: unknown[] }).messages).toHaveLength(13);
  });

  it("zip 안의 txt도 읽는다", async () => {
    const writer = new ZipWriter(new BlobWriter("application/zip"), { useWebWorkers: false });
    await writer.add("Kakaotalk_Chat/KakaoTalkChats.txt", new TextReader(fixture));
    const zip = new File([await writer.close()], "export.zip");
    expect(await runOp({ op: "parse", files: [zip] })).toMatchObject({ formatId: "android-ko" });
  });
});

describe("runOp rename", () => {
  it("발신자만 표시 이름으로 바꾸고 본문은 그대로 둔다", async () => {
    const r = await runOp({ op: "rename", input: rename() });
    expect(r).toMatchObject({ ok: true });
    if (!("messages" in r)) throw new Error("ok가 아니다");
    expect(r.messages.map((m) => [m.sender, m.text])).toEqual([
      ["민지", "철수야 밥 먹자"],
      ["철수", "민지수 왔어"],
      ["철수", "응"],
    ]);
  });

  it("뺀 사람의 메시지는 걸러 낸다(합친 사람 포함)", async () => {
    const input = rename({ excluded: ["철수"] });
    const r = await runOp({ op: "rename", input });
    if (!("messages" in r)) throw new Error("ok가 아니다");
    expect(r.messages.map((m) => m.id)).toEqual([0]);
  });

  it("위험 신호가 있는 메시지는 빼고 뺀 개수를 돌려준다", async () => {
    const r = await runOp({ op: "rename", input: rename({ messages: [msg(0, "김민지", "어제 자해 했어"), msg(1, "철수", "괜찮아?")] }) });
    if (!("messages" in r)) throw new Error("ok가 아니다");
    expect(r.messages.map((m) => m.id)).toEqual([1]);
    expect(r.safetyDropped).toBe(1);
  });

  it("봇·알 수 없음의 메시지는 걸러 낸다", async () => {
    const r = await runOp({ op: "rename", input: rename({ messages: [msg(0, "김민지", "안녕"), msg(1, "(알 수 없음)", "안녕"), msg(2, "철수", "응")] }) });
    if (!("messages" in r)) throw new Error("ok가 아니다");
    expect(r.messages.map((m) => m.id)).toEqual([0, 2]);
    expect(r.safetyDropped).toBe(0);
  });

  it("v2.9: 뺀 사람과 봇·알 수 없음의 원래 이름을 hiddenNames로 돌려준다(자주 쓰는 단어에서 거를 이름)", async () => {
    const input = rename({ messages: [msg(0, "김민지", "안녕"), msg(1, "(알 수 없음)", "안녕"), msg(2, "철수", "응"), msg(3, "영희", "응"), msg(4, "AI봇", "x")], map: { 김민지: "민지", 철수: "철수", 영희: "영희" }, excluded: ["영희"] });
    const r = await runOp({ op: "rename", input });
    if (!("messages" in r)) throw new Error("ok가 아니다");
    expect([...r.hiddenNames].sort()).toEqual(["(알 수 없음)", "AI봇", "영희"].sort());
  });

  it("이름 정리가 실패하면 이유만 돌려준다", async () => {
    expect(await runOp({ op: "rename", input: rename({ map: { 김민지: "P1", 철수: "P1" } }) })).toEqual({ ok: false, reason: "collision" });
    expect(await runOp({ op: "rename", input: rename({ map: { 김민지: "P1", 철수: "a|b" } }) })).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("runOp build", () => {
  const messages = [msg(0, "P1", "안녕"), msg(1, "P2", "반가워"), msg(2, null, "P3님이 나갔습니다.")];
  const base = { messages, tone: "fact" as const, concept: "couple" as const, kind: "pair" as const, tokensPerChar: TOKENS_PER_CHAR };

  it("inputBudget이면 buildPayloadForBudget, tokenBudget이면 buildPayload", async () => {
    expect(await runOp({ op: "build", input: { ...base, inputBudget: FALLBACK_INPUT_TOKEN_BUDGET } })).toEqual(
      buildPayloadForBudget({ ...base, inputBudget: FALLBACK_INPUT_TOKEN_BUDGET }),
    );
    expect(await runOp({ op: "build", input: { ...base, tokenBudget: 40 } })).toEqual(buildPayload({ ...base, tokenBudget: 40 }));
  });
});

describe("handleMessage", () => {
  it("결과를 id와 함께 돌려주고, 던지면 오류 문구로 바꾼다", async () => {
    expect(await handleMessage({ id: 7, op: "rename", input: rename({ map: {} }) })).toEqual({
      id: 7,
      ok: true,
      result: { ok: false, reason: "unmapped" },
    });
    const failed = await handleMessage({
      id: 8,
      op: "build",
      input: { messages: [], tone: "fact", concept: "group", kind: "group", tokensPerChar: 1, tokenBudget: 100 },
    });
    expect(failed).toEqual({ id: 8, ok: false, error: "보낼 메시지가 없다" });
  });
});

describe("Worker 흐름(v2.9): 뺀 멤버의 이름은 어떤 자주 쓰는 단어 목록에도 없다", () => {
  it("parse → rename(영희 빼기) → build(hiddenNames): 다른 사람이 본문에 영희를 불러도 topWords에 영희가 없고, 페이로드에 hiddenNames가 없다", async () => {
    // 철수·민지가 본문에서 뺀 멤버(김영희)와 봇을 자꾸 부른다. 본문은 고치지 않으므로 transcript에는 남지만 단어 목록에는 없어야 한다
    const lines = Array.from({ length: 6 }, (_, i) => [
      `2024년 3월 15일 오후 8:${String(i * 4).padStart(2, "0")}, 철수 : 영희야 영희는 어디야 김영희 치킨 오픈채팅봇`,
      `2024년 3월 15일 오후 8:${String(i * 4 + 1).padStart(2, "0")}, 민지 : 영희한테 물어봐 영희 치킨 철수야`,
      `2024년 3월 15일 오후 8:${String(i * 4 + 2).padStart(2, "0")}, 김영희 : 나 여기 있어 치킨`,
      `2024년 3월 15일 오후 8:${String(i * 4 + 3).padStart(2, "0")}, 오픈채팅봇 : 공지 확인 치킨`,
    ]).flat();
    const text = ["\uFEFF테스트방 님과 카카오톡 대화", "저장한 날짜 : 2024년 3월 16일 오전 9:00", "", "2024년 3월 15일 오후 8:00", ...lines, ""].join("\n");
    const parsed = await runOp({ op: "parse", files: [new File([text], "KakaoTalkChats.txt")] });
    expect(parsed.messages.length).toBe(24);
    const renamed = await runOp({
      op: "rename",
      input: { messages: parsed.messages, map: { 철수: "철수", 민지: "민지", 김영희: "영희" }, merged: [], excluded: ["김영희"] },
    });
    if (!renamed.ok) throw new Error("ok가 아니다");
    expect([...renamed.hiddenNames].sort()).toEqual(["김영희", "오픈채팅봇"]);
    const build = { messages: renamed.messages, concept: "group" as const, kind: "group" as const, tone: "fact" as const, tokensPerChar: TOKENS_PER_CHAR };
    for (const payload of [
      await runOp({ op: "build", input: { ...build, inputBudget: FALLBACK_INPUT_TOKEN_BUDGET, hiddenNames: renamed.hiddenNames } }),
      await runOp({ op: "build", input: { ...build, tokenBudget: 100_000, hiddenNames: renamed.hiddenNames } }),
    ]) {
      expect(payload.members.sort()).toEqual(["민지", "철수"]);
      const words = Object.values(payload.stats.topWords ?? {}).flat().map(([w]) => w);
      expect(words).toContain("치킨");
      expect(words).toContain("철수");
      for (const w of words) expect(w).not.toMatch(/영희|오픈채팅봇/);
      expect(JSON.stringify(payload.stats)).not.toMatch(/영희|오픈채팅봇/);
      expect(Object.keys(payload)).not.toContain("hiddenNames");
      // 본문은 고치지 않는다: 다른 사람이 부른 이름은 transcript에 남는다(전제)
      expect(payload.transcript).toContain("영희야");
    }
  });
});
