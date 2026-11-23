import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FORMAT_IDS } from "../lib/parse/formats";
import { summarizeSample } from "./check-samples";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE_DIR = join(ROOT, "test/fixtures");
const TSX = join(ROOT, "node_modules/.bin/tsx");

const run = (env: Record<string, string | undefined>) =>
  spawnSync(TSX, ["scripts/check-samples.ts"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ANALYTALK_SAMPLES_DIR: undefined, ...env },
  });

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});
const copyFixtures = () => {
  const dir = mkdtempSync(join(tmpdir(), "samples-"));
  tmp.push(dir);
  // 픽스처 맨 앞의 `# ASSUMED: …` 메타 줄은 실제 내보내기에 없으므로 뺀다
  for (const f of readdirSync(FIXTURE_DIR)) {
    if (!/\.(txt|csv)$/.test(f)) continue;
    const text = readFileSync(join(FIXTURE_DIR, f), "utf8").replace(/^\uFEFF?# [^\n]*\n/, "");
    writeFileSync(join(dir, f), text);
  }
  return dir;
};

describe("summarizeSample", () => {
  it("형식·인식률·메시지 수·기간을 돌려준다", () => {
    const s = summarizeSample([{ name: "a.txt", text: "2024년 3월 14일 오전 12:05\n2024년 3월 14일 오전 12:05, 민지 : 하나\n2024년 3월 15일 오후 1:02, 철수 : 둘" }]);
    expect(s.messages).toBe(2);
    expect(s.formatId).not.toBeNull();
    expect(s.recognizedRatio).toBeGreaterThanOrEqual(0.98);
    expect(s.period).toMatch(/^\d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}$/);
  });

  it("형식을 못 알아보면 formatId null, 기간 없음", () => {
    const s = summarizeSample([{ name: "a.txt", text: "그냥 글\n아무 글" }]);
    expect(s.formatId).toBeNull();
    expect(s.period).toBe("-");
  });
});

describe("check-samples CLI", () => {
  it("환경 변수가 없으면 안내 후 정상 종료한다", () => {
    const r = run({});
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/ANALYTALK_SAMPLES_DIR/);
  });

  it("폴더가 없으면 실패한다", () => {
    expect(run({ ANALYTALK_SAMPLES_DIR: "/nonexistent-dir-xyz" }).status).toBe(1);
  });

  it("픽스처 복사본을 샘플로 읽고 대화 내용·파일 이름은 출력하지 않는다", () => {
    const dir = copyFixtures();
    const r = run({ ANALYTALK_SAMPLES_DIR: dir });
    expect(r.status).toBe(0);
    for (const id of FORMAT_IDS) expect(r.stdout).toContain(id);
    expect(r.stdout).not.toMatch(/안녕|민지|철수|android-ko\.txt/);
    expect(r.stdout).toMatch(/미확인/);
  });

  it("지원 형식 전부가 0.98 이상이면 미확인 목록이 비어 있다", () => {
    const dir = copyFixtures();
    const r = run({ ANALYTALK_SAMPLES_DIR: dir });
    expect(r.stdout).toMatch(/미확인 형식: 없음/);
  });

  it("인식률이 낮은 파일만 있으면 해당 형식이 미확인이고 종료 코드 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "samples-"));
    tmp.push(dir);
    const lines = ["[민지] [오후 1:01] 안녕", ...Array.from({ length: 5 }, () => "")];
    lines.push(...Array.from({ length: 3 }, () => "[철수] [오후 1:02"));
    writeFileSync(join(dir, "x.txt"), lines.join("\n"));
    const r = run({ ANALYTALK_SAMPLES_DIR: dir });
    expect(r.status).toBe(1);
  });
});
