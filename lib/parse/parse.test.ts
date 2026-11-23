import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeBytes } from "./decode";
import type { FormatId } from "./formats";
import { parseExport } from "./parse";

const FIXTURE_DIR = fileURLToPath(new URL("../../test/fixtures/", import.meta.url));
const bytes = (file: string) => new Uint8Array(readFileSync(join(FIXTURE_DIR, file)));
/** 픽스처를 업로드처럼 읽는다. 맨 앞 `# ASSUMED: …` 메타 줄은 실제 내보내기에 없으므로 뗀다 */
const load = (file: string) => ({ name: file, text: decodeBytes(bytes(file)).replace(/^(?:# .*\r?\n)+/, "") });
const parse = (file: string) => parseExport([load(file)]);
/** KST 벽시계 → UTC epoch ms */
const kst = (y: number, mo: number, d: number, h: number, mi: number, s = 0) =>
  Date.UTC(y, mo - 1, d, h, mi, s) - 9 * 3_600_000;

const EUC_KR: Record<string, number[]> = { 민: [0xb9, 0xce], 지: [0xc1, 0xf6] };
const eucKr = (s: string) => Uint8Array.from([...s].flatMap((c) => EUC_KR[c] ?? [c.charCodeAt(0)]));

const FIXTURES: [file: string, formatId: FormatId, count: number][] = [
  ["android-ko.txt", "android-ko", 13],
  ["android-ko-legacy.txt", "android-ko-legacy", 6],
  ["ios-ko-dot.txt", "ios-ko-dot", 8],
  ["ios-ko-time.txt", "ios-ko-time", 7],
  ["windows-ko.txt", "windows-ko", 9],
  ["mac-csv.csv", "mac-csv", 6],
  ["ios-ko-dot-split-1.txt", "ios-ko-dot", 2],
  ["ios-ko-dot-split-2.txt", "ios-ko-dot", 2],
];

describe("parseExport", () => {
  it.each(FIXTURES)("%s: 형식을 맞히고 모든 줄을 인식한다", (file, formatId, count) => {
    const r = parseExport([load(file)]);
    expect(r.formatId).toBe(formatId);
    expect(r.messages).toHaveLength(count);
    expect(r.recognizedRatio).toBe(1);
    expect(r.messages.map((m) => m.id)).toEqual([...Array(count).keys()]);
  });

  it("픽스처 바이트: Android·iOS는 BOM, Windows는 BOM 없는 CRLF", () => {
    for (const f of ["android-ko.txt", "android-ko-legacy.txt", "ios-ko-dot.txt", "ios-ko-time.txt"]) {
      expect([f, [...bytes(f).subarray(0, 3)]]).toEqual([f, [0xef, 0xbb, 0xbf]]);
    }
    const win = new TextDecoder().decode(bytes("windows-ko.txt"));
    expect(win.charCodeAt(0)).not.toBe(0xfeff);
    expect(win.split("\n").slice(0, -1).every((l) => l.endsWith("\r"))).toBe(true);
  });

  it("오전 12:05는 00:05, 오후 12:30은 12:30", () => {
    const t = parse("ios-ko-time.txt").messages;
    expect(t[0].ts).toBe(kst(2021, 12, 29, 0, 5));
    expect(t[1].ts).toBe(kst(2021, 12, 29, 12, 30));
    const a = parse("android-ko.txt").messages;
    expect(a[0].ts).toBe(kst(2024, 3, 14, 0, 5));
    expect(a[1].ts).toBe(kst(2024, 3, 14, 12, 30));
    const w = parse("windows-ko.txt").messages;
    expect(w.find((m) => m.text === "자정")?.ts).toBe(kst(2020, 6, 29, 0, 0));
    expect(w.find((m) => m.text === "삭제된 메시지입니다.")?.ts).toBe(kst(2020, 6, 29, 12, 30));
    expect(w.find((m) => m.text === "빈 발신자 알림")?.ts).toBe(kst(2020, 6, 28, 20, 35));
    const l = parse("android-ko-legacy.txt").messages;
    expect(l.find((m) => m.text === "사진")?.ts).toBe(kst(2011, 11, 7, 12, 30));
  });

  it("자정을 넘으면 다음 날짜로 이어진다", () => {
    const at = (file: string, text: string) => parse(file).messages.find((m) => m.text === text)?.ts;
    expect(at("ios-ko-time.txt", "자정 넘음")).toBe(kst(2021, 12, 30, 0, 1));
    expect(at("ios-ko-dot.txt", "자정")).toBe(kst(2024, 3, 15, 0, 0));
    expect(at("android-ko-legacy.txt", "자정 넘음")).toBe(kst(2011, 11, 7, 0, 1));
    expect(at("mac-csv.csv", "자정 넘음, 쉼표")).toBe(kst(2021, 12, 30, 0, 1));
    const ts = parse("ios-ko-time.txt").messages.map((m) => m.ts);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  it("본문 ` : `와 이름의 `,`를 보존한다", () => {
    const a = parse("android-ko.txt").messages;
    expect(a[1]).toMatchObject({ sender: "철수", text: "점심 메뉴 : 김밥" });
    expect(a[2]).toMatchObject({ sender: "민지, 수아", text: "이름에 쉼표" });
    const w = parse("windows-ko.txt").messages;
    expect(w[1]).toMatchObject({ sender: "[지훈]", text: "대괄호 이름" });
    expect(w.find((m) => m.sender === "수아")?.text).toBe("시간 : 자정 직전");
    expect(parse("android-ko-legacy.txt").messages[1]).toMatchObject({ sender: "철수", text: "비율은 1 : 2" });
    expect(parse("ios-ko-dot.txt").messages[2]).toMatchObject({ sender: "철수", text: "몇 시? : 일곱 시" });
    expect(parse("mac-csv.csv").messages[5]).toMatchObject({ sender: "수아", text: "자정 넘음, 쉼표" });
  });

  it("이어지는 줄은 직전 메시지에 \\n으로 붙는다", () => {
    const a = parse("android-ko.txt");
    expect(a.messages[3]).toMatchObject({ sender: "철수", text: "첫 줄\n둘째 줄\n\n넷째 줄", kind: "text", line: 9 });
    expect(a.continuationRatio).toBeGreaterThan(0);
    expect(parse("ios-ko-dot.txt").messages[4]).toMatchObject({ text: "이모티콘\n이어지는 줄", kind: "text" });
    expect(parse("windows-ko.txt").messages[3].text).toBe("여러 줄\n둘째 줄");
    expect(parse("mac-csv.csv").messages[1].text).toBe('여러 줄\n"인용" 포함');
    expect(parse("mac-csv.csv").continuationRatio).toBe(0);
  });

  it("미디어는 사전과 정확히 같을 때만 그 종류다", () => {
    const kinds = parse("android-ko.txt").messages.map((m) => m.kind);
    expect(kinds).toEqual([
      "text",
      "text",
      "text",
      "text",
      "system",
      "photo",
      "emoticon",
      "deleted",
      "system",
      "text",
      "system",
      "file",
      "video",
    ]);
    expect(parse("windows-ko.txt").messages[0].kind).toBe("photo");
    expect(parse("mac-csv.csv").messages[2].kind).toBe("photo");
  });

  it("시스템 메시지는 sender null·kind system, 이름은 systemNames에", () => {
    const a = parse("android-ko.txt");
    expect(a.messages.filter((m) => m.kind === "system").map((m) => [m.sender, m.text])).toEqual([
      [null, "빈 발신자 알림"],
      [null, "영희님을 초대하였습니다."],
      [null, "영희님이 나갔습니다."],
    ]);
    expect(a.systemNames).toEqual(["영희"]);
    expect(a.participants).toEqual(["민지", "철수", "민지, 수아", "영희"]);
    expect(a.messages.every((m) => (m.sender === null) === (m.kind === "system"))).toBe(true);

    expect(parse("ios-ko-dot.txt").systemNames).toEqual(["민지", "철수", "수아"]);
    expect(parse("ios-ko-time.txt").systemNames).toEqual(["철수", "수아"]);
    expect(parse("android-ko-legacy.txt").systemNames).toEqual(["지훈"]);
    const c = parse("mac-csv.csv");
    expect(c.systemNames).toEqual(["철수"]);
    expect(c.participants).toEqual(["민지", "철수", "수아"]);
    // Windows 시스템 줄에는 시각이 없어 직전 시각을 쓴다
    const w = parse("windows-ko.txt");
    expect(w.systemNames).toEqual(["수아"]);
    expect(w.messages.find((m) => m.text === "수아님을 초대하였습니다.")).toMatchObject({
      sender: null,
      kind: "system",
      ts: kst(2020, 6, 28, 20, 36),
    });
  });

  it("기간은 첫·마지막 메시지 시각이다", () => {
    const r = parse("windows-ko.txt");
    expect(r.firstTs).toBe(kst(2020, 6, 28, 1, 1));
    expect(r.lastTs).toBe(kst(2020, 6, 29, 12, 30));
  });

  it("지원하지 않는 텍스트는 formatId null, recognizedRatio < 0.5", () => {
    const text = [
      "KakaoTalk Chats with Friends",
      "Date Saved : Nov 3, 2020, 1:08 PM",
      "",
      "February 10, 2016, 2:33 AM",
      "February 10, 2016, 2:33 AM, you : Photo",
      "그냥 메모",
    ].join("\n");
    const r = parseExport([{ name: "en.txt", text }]);
    expect(r.formatId).toBeNull();
    expect(r.recognizedRatio).toBeLessThan(0.5);
    expect(r).toMatchObject({ messages: [], participants: [], systemNames: [], firstTs: null, lastTs: null });
    expect(parseExport([]).formatId).toBeNull();
    expect(parseExport([{ name: "empty.txt", text: "" }]).recognizedRatio).toBe(0);
  });

  it("머리는 맞는데 해석이 안 되는 줄과 첫 메시지 앞의 줄은 인식률을 낮춘다", () => {
    const text = [
      "테스트방 님과 카카오톡 대화",
      "저장한 날짜 : 2021년 12월 18일 오후 7:17",
      "",
      "알 수 없는 줄",
      "2021년 12월 29일 오후 8:36",
      "2021년 12월 29일 오후 8:36, 민지 : 안녕",
      "2021년 12월 29일 오후 8:37, 모르는 새 알림",
      "2021년 12월 29일 오후 8:38, 철수 : 응",
    ].join("\n");
    const r = parseExport([{ name: "a.txt", text }]);
    expect(r.formatId).toBe("android-ko");
    expect(r.messages.map((m) => m.text)).toEqual(["안녕\n2021년 12월 29일 오후 8:37, 모르는 새 알림", "응"]);
    expect(r.recognizedRatio).toBe(3 / 5);
    expect(r.continuationRatio).toBe(1 / 5);
  });

  it("U+00A0·U+202F 공백도 보통 공백으로 읽는다", () => {
    const text = "2021년 12월 29일 수요일\n오후\u202F8:36,\u00A0민지 : 안녕";
    const r = parseExport([{ name: "a.txt", text }]);
    expect(r.formatId).toBe("ios-ko-time");
    expect(r.messages[0]).toMatchObject({ sender: "민지", ts: kst(2021, 12, 29, 20, 36) });
  });

  it("분할 파일 -2, -1을 순서대로 합치고 헤더를 버린다", () => {
    const r = parseExport([load("ios-ko-dot-split-2.txt"), load("ios-ko-dot-split-1.txt")]);
    expect(r.formatId).toBe("ios-ko-dot");
    expect(r.messages.map((m) => m.text)).toEqual(["첫 파일", "첫 파일 끝", "둘째 파일\n이어지는 줄", "둘째 파일 끝"]);
    expect(r.messages.map((m) => m.id)).toEqual([0, 1, 2, 3]);
    expect(r.recognizedRatio).toBe(1);
    expect(r.firstTs).toBe(kst(2025, 11, 14, 19, 2));
    expect(r.lastTs).toBe(kst(2025, 11, 15, 9, 0));
  });

  it("분할 번호는 숫자 순서이고 Talk_ 제목 줄도 헤더로 버린다", () => {
    const part = (n: number) => ({
      name: `Talk_2025.11.14 19:02-${n}.txt`,
      text: `Talk_2025.11.14 19:02-${n}.txt\n저장한 날짜 : 2025. 11. 16. 오후 2:46\n\n2025. 11. 14. 오후 7:${String(n).padStart(2, "0")}, 민지 : ${n}번\n`,
    });
    const r = parseExport([part(10), part(2), part(9)]);
    expect(r.messages.map((m) => m.text)).toEqual(["2번", "9번", "10번"]);
    expect(r.recognizedRatio).toBe(1);
  });

  it("10만 메시지 5초 이내", () => {
    const text = androidExport(100_000);
    const t0 = performance.now();
    const r = parseExport([{ name: "big.txt", text }]);
    const ms = performance.now() - t0;
    expect(r.messages).toHaveLength(100_000);
    expect(r.recognizedRatio).toBe(1);
    expect(r.lastTs).toBe(Date.UTC(2020, 0, 1) + 99_999 * 60_000 - 9 * 3_600_000);
    expect(ms).toBeLessThan(5_000);
  }, 60_000);

  it("50MB 텍스트 10초 이내", () => {
    const encoded = new TextEncoder().encode(androidExport(640_000));
    expect(encoded.length).toBeGreaterThanOrEqual(50 * 1024 * 1024);
    const t0 = performance.now();
    const r = parseExport([{ name: "big.txt", text: decodeBytes(encoded) }]);
    const ms = performance.now() - t0;
    expect(r.messages).toHaveLength(640_000);
    expect(ms).toBeLessThan(10_000);
  }, 120_000);
});

describe("decodeBytes", () => {
  it("euc-kr 바이트도 읽는다", () => expect(decodeBytes(eucKr("민지"))).toContain("민지"));

  it("UTF-8은 그대로 읽고 맨 앞 BOM을 지운다", () => {
    expect(decodeBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("민지 : 안녕")]))).toBe("민지 : 안녕");
    expect(decodeBytes(new TextEncoder().encode("[민지] [20:36] 안녕"))).toBe("[민지] [20:36] 안녕");
  });
});

/** 1분 간격 Android 형식 대화. 본문이 길어 한 줄이 약 85바이트다 */
function androidExport(n: number): string {
  const lines = ["테스트방 님과 카카오톡 대화", "저장한 날짜 : 2024년 3월 16일 오전 11:29", ""];
  const pad = (v: number) => String(v).padStart(2, "0");
  for (let i = 0; i < n; i++) {
    const t = new Date(Date.UTC(2020, 0, 1) + i * 60_000);
    const h = t.getUTCHours();
    const stamp = `${t.getUTCFullYear()}년 ${t.getUTCMonth() + 1}월 ${t.getUTCDate()}일 ${h < 12 ? "오전" : "오후"} ${h % 12 || 12}:${pad(t.getUTCMinutes())}`;
    lines.push(`${stamp}, ${i % 2 ? "민지" : "철수"} : 메시지 ${i}번 내용입니다 ㅋㅋㅋ 오늘 뭐 해?`);
  }
  return lines.join("\n");
}
