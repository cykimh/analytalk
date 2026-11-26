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
