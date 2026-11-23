import { describe, expect, it } from "vitest";
import { parseExport } from "../lib/parse/parse";
import { checkFixture } from "./check-fixtures";
import { skeletonize } from "./skeletonize";

// 실제 대화처럼 보이게 손으로 만든 가짜 원본. 이름·방 이름·번호·주소는 모두 지어낸 값이다.
const FAKE_ANDROID = [
  "\uFEFF우리반 단톡 님과 카카오톡 대화",
  "저장한 날짜 : 2024년 3월 16일 오전 11:29",
  "",
  "",
  "2024년 3월 14일 오전 12:05",
  "2024년 3월 14일 오전 12:05, 김하늘 : 하늘이 왔어 010-9876-5432",
  "2024년 3월 14일 오후 12:30, 박서준 : 김하늘 사진 봤어? https://example.com/abc",
  "둘째 줄 Hello 42번",
  "2024년 3월 14일 오후 12:31, 박서준 : 사진",
  "2024년 3월 14일 오후 12:32, 김하늘 : 이모티콘",
  "2024년 3월 14일 오후 12:33, 박서준 : 삭제된 메시지입니다.",
  "2024년 3월 14일 오후 12:34, 김하늘님이 이도윤님을 초대했습니다.",
  "2024년 3월 14일 오후 12:35, 이도윤님을 초대하였습니다.",
  "2024년 3월 14일 오후 12:36, 이도윤님이 나갔습니다.",
  "",
].join("\n");
const FAKE_ANDROID_NAMES = ["김하늘", "박서준", "이도윤"];

const FAKE_WINDOWS = [
  "우리반 님과 카카오톡 대화",
  "저장한 날짜 : 2020-11-03 10:44:52",
  "",
  "--------------- 2020년 6월 28일 일요일 ---------------",
  "[김하늘] [오전 1:01] 사진",
  "[박서준] [20:36] 월요일에 보자",
  "이도윤님이 나갔습니다.",
].join("\r\n");

describe("skeletonize", () => {
  it("원래 이름·방 이름이 0건이다", () => {
    const out = skeletonize(FAKE_ANDROID, FAKE_ANDROID_NAMES);
    for (const real of ["김하늘", "하늘", "박서준", "서준", "이도윤", "도윤", "우리반", "단톡"]) {
      expect(out).not.toContain(real);
    }
  });

  it("이름은 ALLOWED_NAMES로 1:1, 헤더 첫 줄은 테스트방으로 바꾼다", () => {
    const lines = skeletonize(FAKE_ANDROID, FAKE_ANDROID_NAMES).split("\n");
    expect(lines[0]).toBe("\uFEFF테스트방 님과 카카오톡 대화");
    expect(lines[5]).toBe("2024년 3월 14일 오전 12:05, 민지 : 가가가 가가 000-0000-0000");
    expect(lines[6]).toBe("2024년 3월 14일 오후 12:30, 철수 : 민지 사진 가가? aaaaa://aaaaaaa.aaa/aaa");
    expect(lines[7]).toBe("가가 가 aaaaa 00가");
    expect(lines[11]).toBe("2024년 3월 14일 오후 12:34, 민지님이 영희님을 초대했습니다.");
  });

  it("형식 키워드와 날짜·시각 숫자는 남는다", () => {
    const out = skeletonize(FAKE_ANDROID, FAKE_ANDROID_NAMES);
    for (const kw of [
      "저장한 날짜 : 2024년 3월 16일 오전 11:29",
      "오전",
      "오후",
      "님이",
      "초대",
      "님을 초대하였습니다.",
      "나갔습니다.",
      "사진",
      "이모티콘",
      "삭제된 메시지입니다.",
    ]) {
      expect(out).toContain(kw);
    }
    const win = skeletonize(FAKE_WINDOWS, FAKE_ANDROID_NAMES);
    expect(win).toContain("--------------- 2020년 6월 28일 일요일 ---------------\r\n");
    expect(win).toContain("[철수] [20:36] 월요일가 가가\r\n");
    expect(win).toContain("저장한 날짜 : 2020-11-03 10:44:52\r\n");
  });

  it("긴 이름부터 바꿔서 짧은 이름이 긴 이름을 쪼개지 않는다", () => {
    const out = skeletonize("[김하늘] [20:36] 하늘아", ["하늘", "김하늘"]);
    expect(out).toBe("[철수] [20:36] 민지가");
  });

  it("mac CSV 머리 줄은 그대로 둔다", () => {
    const out = skeletonize('Date,User,Message\n2021-12-29 20:36:00,"김하늘","ㅎㅇ ""인용"""\n', ["김하늘"]);
    expect(out).toBe('Date,User,Message\n2021-12-29 20:36:00,"민지","가가 ""가가"""\n');
  });

  it("이름이 ALLOWED_NAMES 사람 수보다 많으면 던진다", () => {
    expect(() => skeletonize("x", ["가1", "가2", "가3", "가4", "가5", "가6"])).toThrow();
  });

  it("날짜는 7의 배수 일수로만 민다(요일 유지)", () => {
    const text = "2024년 3월 28일 목요일\n2024. 3. 28. 오후 7:12, 김하늘 : 안녕\n2021-12-29 20:36:00,\"김하늘\",\"x\"";
    const out = skeletonize(text, ["김하늘"], { shiftWeeks: 1 });
    expect(out.split("\n")).toEqual([
      "2024년 4월 4일 목요일",
      "2024. 4. 4. 오후 7:12, 민지 : 가가",
      '2022-01-05 20:36:00,"민지","a"',
    ]);
    expect(() => skeletonize(text, ["김하늘"], { shiftWeeks: 0.5 })).toThrow();
  });

  it("결과는 픽스처 검사를 통과한다", () => {
    expect(checkFixture("android-ko.txt", skeletonize(FAKE_ANDROID, FAKE_ANDROID_NAMES))).toEqual([]);
  });

  it("결과는 원본과 같은 형식으로 모든 줄이 읽힌다", () => {
    const before = parseExport([{ name: "a.txt", text: FAKE_ANDROID }]);
    const after = parseExport([{ name: "a.txt", text: skeletonize(FAKE_ANDROID, FAKE_ANDROID_NAMES) }]);
    expect(after.formatId).toBe("android-ko");
    expect(after.recognizedRatio).toBe(1);
    expect(after.messages.map((m) => [m.ts, m.kind])).toEqual(before.messages.map((m) => [m.ts, m.kind]));
    expect(after.participants).toEqual(["민지", "철수"]);
    expect(after.systemNames).toEqual(["민지", "영희"]);
  });
});
