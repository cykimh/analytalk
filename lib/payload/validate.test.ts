import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/lib/parse/parse";
import { buildPayload, type Payload } from "./build";
import { sha256Hex } from "./hash";
import { validatePayload } from "./validate";

const kst = (d: number, h: number, mi: number) => Date.UTC(2026, 9, d, h, mi) - 9 * 3_600_000;

function payload(): Payload {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < 40; i++) {
    const sender = i % 2 ? "P2" : "P1";
    messages.push({ id: i, ts: kst(1 + Math.floor(i / 10), 10, i), sender, kind: "text", text: `메시지 ${i} https://a.kr`, line: i + 1 });
  }
  return buildPayload({ messages, me: "P1", concept: "couple", kind: "pair", tokenBudget: 400, tokensPerChar: 1 });
}

/** transcript 끝에 같은 시각·다음 msg_id로 줄 하나를 붙이고 msgSent도 늘린다 */
function appendLine(p: Payload, body: string, sender = "P1", idDelta = 1): Payload {
  const [, id, stamp] = /^m(\d+)\|([^|]+)\|/.exec(p.transcript.split("\n").at(-1)!)!;
  return { ...p, transcript: `${p.transcript}\nm${Number(id) + idDelta}|${stamp}|${sender}|${body}`, msgSent: p.msgSent + 1 };
}

const reject = (raw: unknown) => {
  const r = validatePayload(raw);
  return r.ok ? "ok" : r.error;
};

describe("validatePayload", () => {
  it("buildPayload 결과(네트워크를 거친 JSON 포함)를 받는다", () => {
    const p = payload();
    expect(p.anchors).not.toBe("");
    expect(validatePayload(p)).toEqual({ ok: true, payload: p });
    expect(validatePayload(JSON.parse(JSON.stringify(p))).ok).toBe(true);
    expect(validatePayload(appendLine(p, "평범한 본문 | 파이프")).ok).toBe(true);
  });

  it("transcript에 <script> → 거부", () => {
    expect(reject(appendLine(payload(), "<script>alert(1)</script>"))).toMatch(/꺾쇠/);
  });

  it("가리기를 빠뜨린 전화번호 → 거부", () => {
    expect(reject(appendLine(payload(), "내 번호 010-1234-5678"))).toMatch(/가리기/);
  });

  it("1.5MB 초과 → 거부", () => {
    expect(reject({ ...payload(), anchors: "가".repeat(600_000) })).toMatch(/크기/);
  });

  it("members 밖의 stats 키 → 거부", () => {
    const p = payload();
    expect(reject({ ...p, stats: { ...p.stats, byPerson: { ...p.stats.byPerson, 김민지: 3 } } })).toMatch(/stats/);
    const monthly = { "2026-10": { ...p.stats.monthly["2026-10"], avgLen: { P1: 1, 김민지: 2 } } };
    expect(reject({ ...p, stats: { ...p.stats, monthly } })).toMatch(/stats/);
  });

  it("concept couple + kind group → 거부", () => {
    expect(reject({ ...payload(), kind: "group" })).toMatch(/concept/);
    expect(reject({ ...payload(), concept: "group", kind: "pair" })).toMatch(/concept/);
    expect(reject({ ...payload(), concept: "group", kind: "group" })).toBe("ok");
  });

  it("members 밖의 발신자, 줄어드는 msg_id, 틀린 줄 형식, 구조 오류 → 거부", () => {
    const p = payload();
    expect(reject(appendLine(p, "안녕", "P9"))).toMatch(/발신자/);
    expect(reject(appendLine(p, "안녕", "P1", 0))).toMatch(/msg_id/);
    expect(reject({ ...p, transcript: `${p.transcript}\n그냥 한 줄` })).toMatch(/줄 형식/);
    expect(reject({ ...p, me: "P9" })).toMatch(/me/);
    expect(reject({ ...p, v: 2 })).toMatch(/구조/);
    expect(reject({ ...p, extra: 1 })).toMatch(/구조/);
    expect(reject({ ...p, maskCounts: { ...p.maskCounts, 김민지: 1 } })).toMatch(/구조/);
    expect(reject(null)).toMatch(/구조/);
  });

  it("이모지 20개 표시 이름(UTF-16 40자)도 받는다", () => {
    const name = "😀".repeat(20);
    const messages: ChatMessage[] = [
      { id: 0, ts: kst(1, 10, 0), sender: name, kind: "text", text: "안녕", line: 1 },
      { id: 1, ts: kst(1, 10, 1), sender: "P2", kind: "text", text: "응", line: 2 },
    ];
    const p = buildPayload({ messages, me: name, concept: "couple", kind: "pair", tokenBudget: 1000, tokensPerChar: 1 });
    expect(reject(p)).toBe("ok");
  });

  it("날짜 헤더가 줄의 MM-DD와 다르면 → 거부", () => {
    const p = payload();
    const headers = p.transcript.match(/^# \d{4}-\d{2}-\d{2}$/gm)!;
    expect(reject({ ...p, transcript: p.transcript.replace(headers[0], "# 2026-12-25") })).toMatch(/날짜 헤더/);
  });

  it("msgSent가 transcript 메시지 수와 다르거나 transcript가 비면 → 거부", () => {
    const p = payload();
    expect(reject({ ...p, msgSent: p.msgSent + 1 })).toMatch(/msgSent/);
    expect(reject({ ...p, transcript: "" })).toMatch(/msgSent/);
    expect(reject({ ...p, transcript: "", msgSent: 0 })).toMatch(/구조/);
  });
});

describe("sha256Hex", () => {
  it("WebCrypto SHA-256 16진수", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
