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
    ...(withProd
      ? [
          {
            command: "pnpm build && ANALYTALK_E2E=1 pnpm start --port 3200",
            url: "http://localhost:3200",
            reuseExistingServer: false,
            timeout: 300_000,
          },
        ]
      : []),
  ],
});
