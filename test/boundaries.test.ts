// 저장소 전체 소스를 읽어 보안 경계를 확인한다 (테스트 파일·test/·e2e/는 뺀다).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP_ANYWHERE = new Set(["node_modules", ".next", ".git", ".vercel", "test-results", "playwright-report"]);
const SKIP_TOP = new Set(["test", "e2e"]);
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function sourceFiles(dir = "", depth = 0): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_ANYWHERE.has(entry.name) || (depth === 0 && SKIP_TOP.has(entry.name))) continue;
      out.push(...sourceFiles(rel, depth + 1));
    } else if (SOURCE.test(entry.name) && !/\.test\.[a-z]+$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

const files = sourceFiles();
const text = new Map(files.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]));
const filesMatching = (re: RegExp) => files.filter((f) => re.test(text.get(f)!)).sort();

const PRIVILEGED = ["lib/server/privileged.ts", "scripts/invite.ts"];

describe("소스 경계", () => {
  it("앱·라이브러리·스크립트 소스를 읽는다", () => {
    expect(files).toEqual(expect.arrayContaining([...PRIVILEGED, "app/api/invite/route.ts", "lib/config.ts", "lib/server/repo.ts"]));
    expect(files.some((f) => f.startsWith("test/") || f.startsWith("e2e/") || f.includes("node_modules/"))).toBe(false);
  });

  it("supabase-js createClient import는 privileged.ts·scripts/invite.ts뿐이다", () => {
    expect(filesMatching(/import\s*\{[^}]*\bcreateClient\b[^}]*\}\s*from\s*["']@supabase\/supabase-js["']/)).toEqual(PRIVILEGED);
    // 다른 꼴(동적 import·require·네임스페이스 import)로도 supabase-js를 부르지 않는다
    expect(filesMatching(/@supabase\/supabase-js/)).toEqual(PRIVILEGED);
  });

  it("SUPABASE_SECRET_KEY 참조는 privileged.ts·scripts/invite.ts뿐이다", () => {
    expect(filesMatching(/SUPABASE_SECRET_KEY/)).toEqual(PRIVILEGED);
  });

  it("템플릿의 @supabase/ssr 클라이언트를 쓰지 않는다", () => {
    expect(filesMatching(/@supabase\/ssr/)).toEqual([]);
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect({ ...pkg.dependencies, ...pkg.devDependencies }).not.toHaveProperty("@supabase/ssr");
  });

  it("dangerouslySetInnerHTML을 쓰지 않는다", () => {
    expect(filesMatching(/dangerouslySetInnerHTML/)).toEqual([]);
  });

  it("console.* 줄에 payload·transcript·anchors가 나오지 않는다", () => {
    const hits = files.flatMap((f) =>
      text
        .get(f)!
        .split("\n")
        .flatMap((line, i) => (/\bconsole\.\w+/.test(line) && /payload|transcript|anchors/i.test(line) ? [`${f}:${i + 1}`] : [])),
    );
    expect(hits).toEqual([]);
  });

  it("내부 편 호출(HMAC 라우트)의 흔적이 없다", () => {
    expect(filesMatching(/INTERNAL_HMAC_SECRET|\/api\/internal|x-analytalk-signature/)).toEqual([]);
    expect(files.some((f) => f.startsWith("app/api/internal/"))).toBe(false);
  });

  it("isE2E 정의에 VERCEL 검사가 있다", () => {
    expect(text.get("lib/config.ts")).toMatch(/export const isE2E\s*=[^\n]*&&\s*!process\.env\.VERCEL\b/);
  });
});
