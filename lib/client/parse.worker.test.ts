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
  map: { 김민지: "P1", 철수: "P2" },
  systemNames: [],
  merged: [],
  fixes: {},
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
  it("이름을 바꾸고 남은 조각을 함께 돌려준다(안전 신호는 페이로드를 만든 뒤 sentSafetySignal이 본다)", async () => {
    const r = await runOp({ op: "rename", input: rename() });
    expect(r).toMatchObject({ ok: true, leftovers: [{ piece: "민지", count: 1, ids: [1] }] });
    expect(r).not.toHaveProperty("safety");
    if (!("messages" in r)) throw new Error("ok가 아니다");
    expect(r.messages.map((m) => [m.sender, m.text])).toEqual([
      ["P1", "P2야 밥 먹자"],
      ["P2", "민지수 왔어"],
      ["P2", "응"],
    ]);
  });

  it("fixes의 조각은 글자 그대로(대소문자 무시) 그 표시 이름으로 바꾸고 남은 조각에서 빠진다", async () => {
    const input = rename({
      messages: [msg(0, "Minji Kim", "hi"), msg(1, "철수", "MINJIabc 민지수 왔어")],
      map: { "Minji Kim": "P1", 철수: "P2" },
    });
    const before = await runOp({ op: "rename", input });
    expect(before).toMatchObject({ ok: true, leftovers: [{ piece: "Minji" }] });
    const r = await runOp({ op: "rename", input: { ...input, fixes: { Minji: "P1" } } });
    expect(r).toMatchObject({ ok: true, leftovers: [] });
    if (!("messages" in r)) throw new Error("ok가 아니다");
    expect(r.messages[1].text).toBe("P1abc 민지수 왔어");
  });

  it("시스템·미디어 메시지 본문은 fixes로 바꾸지 않는다", async () => {
    const input = rename({
      messages: [msg(0, "김민지", "a"), msg(1, null, "민지수님이 나갔습니다."), msg(2, "철수", "민지수", "photo")],
      fixes: { 민지: "P1" },
    });
    const r = await runOp({ op: "rename", input });
    if (!("messages" in r)) throw new Error("ok가 아니다");
    expect(r.messages.map((m) => m.text)).toEqual(["a", "민지수님이 나갔습니다.", "민지수"]);
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
