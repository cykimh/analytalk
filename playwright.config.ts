import { defineConfig, devices } from "@playwright/test";

const browsers = [
  { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  { name: "webkit", use: { ...devices["Desktop Safari"] } },
];

// prod 빌드(3200)는 빌드에 몇 분이 걸려서 PW_PROD=1일 때만 띄운다(CSP·헤더 검증용, Task 15).
// 예: PW_PROD=1 pnpm test:e2e --project=prod-chromium --project=prod-webkit
const withProd = process.env.PW_PROD === "1";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  reporter: "list",
  projects: [
    // 기본: dev 서버(3100), security.spec.ts 는 prod 프로젝트에서만 돈다
    ...browsers.map((b) => ({
      name: b.name,
      use: { ...b.use, baseURL: "http://localhost:3100" },
      testIgnore: /security\.spec\.ts/,
    })),
    // prod 빌드(3200): CSP·헤더 검증 전용
    ...(withProd
      ? browsers.map((b) => ({
          name: `prod-${b.name}`,
          use: { ...b.use, baseURL: "http://localhost:3200" },
          testMatch: /security\.spec\.ts/,
        }))
      : []),
  ],
  webServer: [
    {
      command: "ANALYTALK_E2E=1 pnpm dev --port 3100",
      url: "http://localhost:3100",
      reuseExistingServer: false,
      timeout: 120_000,
    },
    // 빌드 출력은 security.spec.ts가 라우트 표(모두 ƒ)를 읽도록 test-results/prod-build.log에 남긴다
    // (Playwright가 test-results를 비운 뒤에 webServer를 띄운다). 사이트 키는 Cloudflare 공식 테스트 키(늘 통과)다
    ...(withProd
      ? [
          {
            command:
              "mkdir -p test-results && (NEXT_PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA pnpm build > test-results/prod-build.log 2>&1 || (cat test-results/prod-build.log >&2; exit 1)) && ANALYTALK_E2E=1 pnpm start --port 3200",
            url: "http://localhost:3200",
            reuseExistingServer: false,
            timeout: 300_000,
          },
        ]
      : []),
  ],
});
