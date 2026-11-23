import { defineConfig, devices } from "@playwright/test";

const browsers = [
  { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  { name: "webkit", use: { ...devices["Desktop Safari"] } },
];

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
    ...browsers.map((b) => ({
      name: `prod-${b.name}`,
      use: { ...b.use, baseURL: "http://localhost:3200" },
      testMatch: /security\.spec\.ts/,
    })),
  ],
  webServer: [
    {
      command: "ANALYTALK_E2E=1 pnpm dev --port 3100",
      url: "http://localhost:3100",
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "pnpm build && ANALYTALK_E2E=1 pnpm start --port 3200",
      url: "http://localhost:3200",
      reuseExistingServer: false,
      timeout: 300_000,
    },
  ],
});
