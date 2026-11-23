import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALLOWED_NAMES, checkFixture } from "./check-fixtures";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE_DIR = join(ROOT, "test/fixtures");
const TSX = join(ROOT, "node_modules/.bin/tsx");

const runCli = (...args: string[]) =>
  spawnSync(TSX, ["scripts/check-fixtures.ts", ...args], { cwd: ROOT, encoding: "utf8" });

describe("checkFixture", () => {
  it("ALLOWED_NAMES는 정해진 6개다", () => {
    expect(ALLOWED_NAMES).toEqual(["민지", "철수", "영희", "지훈", "수아", "테스트방"]);
  });

  it("전화번호가 있으면 오류 1개", () => {
    expect(checkFixture("a.txt", "[민지] [오후 1:01] 010-1234-5678")).toHaveLength(1);
  });

  it("이메일과 URL도 각각 오류", () => {
    const errors = checkFixture("a.txt", "[민지] [오후 1:01] a.b@example.com 그리고 https://example.com/x");
    expect(errors).toHaveLength(2);
  });

  it("발신자 이름이 ALLOWED_NAMES 밖이면 오류", () => {
    const errors = checkFixture("a.txt", "[홍길동] [오후 1:01] 안녕");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/이름/);
  });

  it("시스템 줄 이름이 ALLOWED_NAMES 밖이면 오류", () => {
    const errors = checkFixture("a.txt", "홍길동님이 나갔습니다.");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/이름/);
  });

  it("초대 줄은 초대한 사람과 초대받은 사람을 모두 검사한다", () => {
    const text = "2024. 3. 14. 오후 7:13, 민지님이 홍길동님을 초대했습니다.";
    expect(checkFixture("a.txt", text)).toHaveLength(1);
  });

  it("파일 이름 Talk_우리방.txt는 이름 규칙 오류", () => {
    const errors = checkFixture("Talk_우리방.txt", "[민지] [오후 1:01] 안녕");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/파일 이름/);
  });

  it("헤더 방 이름이 테스트방이 아니면 오류", () => {
    const text = "우리반 님과 카카오톡 대화\n저장한 날짜 : 2020-11-03 10:44:52\n\n[민지] [20:36] 안녕";
    const errors = checkFixture("a.txt", text);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/방 이름/);
  });

  it("허용 이름에 쉼표·대괄호를 붙인 이름과 빈 발신자는 통과한다", () => {
    const text = [
      "# ASSUMED: zeikar/kakaotalk-viewer",
      "테스트방 님과 카카오톡 대화",
      "저장한 날짜 : 2020-11-03 10:44:52",
      "",
      "--------------- 2020년 6월 28일 일요일 ---------------",
      "[[지훈]] [오전 1:03] 대괄호",
      "[민지, 수아] [오전 1:04] 쉼표",
      "[] [20:35] 빈 발신자",
    ].join("\n");
    expect(checkFixture("windows-ko.txt", text)).toEqual([]);
  });

  it("mac CSV의 발신자와 시스템 문구도 검사한다", () => {
    const text = 'Date,User,Message\n2021-12-29 20:36:00,"홍길동","안녕"\n2021-12-29 20:39:00,"민지","김철수님이 나갔습니다."\n';
    expect(checkFixture("mac-csv.csv", text)).toHaveLength(2);
  });

  describe("U+202F·U+00A0 공백은 파서처럼 정규화한 뒤 형식을 감지한다", () => {
    const iosTime = (sender: string, dateLines: number) =>
      [
        "# ASSUMED: zeikar/kakaotalk-viewer",
        "테스트방 님과 카카오톡 대화",
        "저장한 날짜 : 2021. 12. 31. 오후 2:46",
        "",
        "2021년 12월 29일 수요일",
        `오후 8:36, ${sender} : 안녕`,
        ...(dateLines > 1 ? ["2021년 12월 30일 목요일"] : []),
        `오후 8:37, ${sender} : 응`,
      ].join("\n");

    it("허용 이름만 쓴 ios-ko-time 픽스처는 통과한다", () => {
      expect(checkFixture("ios-ko-time.txt", iosTime("민지", 1))).toEqual([]);
    });

    it("같은 입력의 발신자가 ALLOWED_NAMES 밖이면 줄마다 이름 오류", () => {
      expect(checkFixture("ios-ko-time.txt", iosTime("홍길동", 1))).toEqual([
        "6행: ALLOWED_NAMES 밖의 이름",
        "7행: ALLOWED_NAMES 밖의 이름",
      ]);
    });

    it("원본 줄로는 ios-ko-dot과 동점이 되는 입력도 이름 검사를 건너뛰지 않는다", () => {
      expect(checkFixture("ios-ko-time.txt", iosTime("홍길동", 2))).toEqual([
        "6행: ALLOWED_NAMES 밖의 이름",
        "8행: ALLOWED_NAMES 밖의 이름",
      ]);
    });
  });

  it("형식을 알아볼 수 없으면 이름을 검사하지 못했다는 오류", () => {
    expect(checkFixture("a.txt", "그냥 아무 글\n또 아무 글")).toHaveLength(1);
  });

  it("오류 문구에 원래 값(이름·번호)을 싣지 않는다", () => {
    const errors = checkFixture("a.txt", "[홍길동] [오후 1:01] 010-1234-5678");
    expect(errors).toHaveLength(2);
    expect(errors.join("\n")).not.toMatch(/홍길동|1234/);
  });

  it("저장소의 모든 픽스처가 통과한다", () => {
    const files = readdirSync(FIXTURE_DIR).filter((f) => /\.(txt|csv)$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const f of files) {
      expect([f, checkFixture(f, readFileSync(join(FIXTURE_DIR, f), "utf8"))]).toEqual([f, []]);
    }
  });
});

describe("check-fixtures CLI", () => {
  it("인자 없이 test/fixtures 전체를 검사하고 통과하면 0으로 끝난다", () => {
    const r = runCli();
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("문제 있는 파일을 주면 1로 끝나고 원래 값을 출력하지 않는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "analytalk-fixture-"));
    try {
      const bad = join(dir, "Talk_우리방.txt");
      writeFileSync(bad, "[홍길동] [오후 1:01] 010-1234-5678\n");
      const r = runCli(bad);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/파일 이름/);
      expect(r.stderr + r.stdout).not.toMatch(/홍길동|1234/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
