// prod 빌드(3200)에서만 돈다: PW_PROD=1 pnpm test:e2e --project=prod-chromium --project=prod-webkit
// CSP(nonce + strict-dynamic)·모든 페이지 동적 렌더·초대 게이트를 실제 빌드로 확인한다.
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { E2E_INVITE_CODE, SESSION_COOKIE } from "@/lib/config";
import { androidChat, login, textUpload, zipUpload } from "./helpers";

/** playwright.config.ts의 prod webServer가 `pnpm build` 출력을 여기에 남긴다 */
const BUILD_LOG = path.join(__dirname, "..", "test-results", "prod-build.log");
const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

const nonceOf = (csp: string | undefined) => /'nonce-([^']+)'/.exec(csp ?? "")?.[1];

/**
 * 이 탭의 최상위 문서에서 일어난 CSP 위반을 모은다. 페이지를 옮겨도 이어서 모은다.
 * Turnstile iframe은 Cloudflare 문서라 그쪽 정책이 걸리므로 세지 않는다
 */
async function watchCsp(page: Page): Promise<string[]> {
  const violations: string[] = [];
  await page.exposeBinding("__cspViolation", (_source, text: string) => {
    violations.push(text);
  });
  await page.addInitScript(() => {
    if (window.top !== window) return;
    document.addEventListener("securitypolicyviolation", (e) => {
      const report = (window as unknown as { __cspViolation: (text: string) => void }).__cspViolation;
      void report(`${e.effectiveDirective} ${e.blockedURI} (${e.sourceFile}:${e.lineNumber})`);
    });
  });
  return violations;
}

const next = (page: Page) => page.getByRole("button", { name: "다음", exact: true });

/** 확인 → 나는 누구? → 이름 정리(기본 이름) → 방 종류·말투 → 보낼 내용 확인 */
async function toReview(page: Page) {
  await next(page).click();
  await page.getByRole("radio", { name: "민지", exact: true }).check();
  await next(page).click();
  await expect(page.getByRole("heading", { name: "이름 정리" })).toBeVisible();
  await next(page).click();
  await expect(page.getByRole("heading", { name: "방 종류와 말투" })).toBeVisible();
  await next(page).click();
  await expect(page.getByRole("heading", { name: "보낼 내용 확인" })).toBeVisible({ timeout: 15_000 });
}

test("pnpm build 출력에서 페이지 라우트가 모두 ƒ(요청마다 렌더)다", () => {
  // Playwright가 webServer에 FORCE_COLOR를 넘겨 출력에 색 코드가 섞인다
  const log = readFileSync(BUILD_LOG, "utf8").replace(/\x1b\[[0-9;]*m/g, "");
  const routes = [...log.matchAll(/^[┌├└]\s+(\S+)\s+(\/\S*)/gm)].map(([, mark, route]) => ({ mark, route }));
  const pages = routes.filter((r) => !r.route.startsWith("/api/"));
  expect(pages.map((r) => r.route)).toEqual(
    expect.arrayContaining(["/", "/_not-found", "/about", "/new", "/c/[id]", "/c/[id]/steps", "/c/[id]/e/[n]", "/s/[token]"]),
  );
  expect(pages.filter((r) => r.mark !== "ƒ")).toEqual([]);
});

test("/new HTML의 모든 <script>에 이 응답 CSP의 nonce가 붙고, nonce는 요청마다 바뀐다", async ({ page }) => {
  await login(page);
  const first = await page.request.get("/new");
  expect(first.status()).toBe(200);
  const csp = first.headers()["content-security-policy"];
  const nonce = nonceOf(csp)!;
  expect(nonce).toBeTruthy();
  expect(csp).toContain("'strict-dynamic'");
  expect(csp).not.toContain("'unsafe-eval'");

  const scripts = (await first.text()).match(/<script\b[^>]*>/g) ?? [];
  expect(scripts.length).toBeGreaterThan(0);
  expect(scripts.filter((tag) => !tag.includes(` nonce="${nonce}"`))).toEqual([]);

  const second = await page.request.get("/new");
  expect(nonceOf(second.headers()["content-security-policy"])).not.toBe(nonce);
});

test.describe("CSP 위반 0건", () => {
  test("/: Turnstile 테스트 sitekey 위젯으로 코드를 넣고 /new까지", async ({ page }) => {
    const violations = await watchCsp(page);
    const res = await page.goto("/");
    const nonce = nonceOf(res?.headers()["content-security-policy"]);
    expect(nonce).toBeTruthy();

    await page.getByLabel("초대 코드").fill(E2E_INVITE_CODE);
    // Cloudflare 테스트 sitekey(1x00000000000000000000AA)는 늘 통과시키고 토큰을 준다. 토큰이 와야 버튼이 열린다
    await expect.poll(() => page.frames().some((f) => f.url().startsWith(TURNSTILE_ORIGIN)), { timeout: 30_000 }).toBe(true);
    const enter = page.getByRole("button", { name: "들어가기" });
    await expect(enter).toBeEnabled({ timeout: 30_000 });
    // Turnstile 스크립트에는 layout이 읽은 nonce가 붙는다
    const scriptNonces = await page.evaluate(
      (src) => [...document.scripts].filter((s) => s.src.startsWith(src)).map((s) => s.nonce),
      `${TURNSTILE_ORIGIN}/turnstile/v0/api.js`,
    );
    expect(scriptNonces).toEqual([nonce]);

    await enter.click();
    await expect(page).toHaveURL(/\/new$/);
    await expect(page.getByLabel("대화 파일")).toBeAttached();
    expect(violations).toEqual([]);
  });

  test("/new: txt 업로드 → Worker 파싱 → 보낼 내용 확인", async ({ page }) => {
    const violations = await watchCsp(page);
    await login(page);
    const res = await page.goto("/new");
    expect(nonceOf(res?.headers()["content-security-policy"])).toBeTruthy();
    await page.getByLabel("대화 파일").setInputFiles(textUpload("KakaoTalkChats.txt", androidChat()));
    await expect(page.getByText("메시지 11개")).toBeVisible();
    await toReview(page);
    expect(violations).toEqual([]);
  });

  test("/new: zip 업로드 → Worker 파싱", async ({ page }) => {
    const violations = await watchCsp(page);
    await login(page);
    const res = await page.goto("/new");
    expect(nonceOf(res?.headers()["content-security-policy"])).toBeTruthy();
    const zip = await zipUpload("Kakaotalk_Chat_테스트방.zip", [
      ["Kakaotalk_Chat_테스트방/KakaoTalkChats.txt", androidChat()],
      ["Kakaotalk_Chat_테스트방/photo.jpg", "not an image"],
    ]);
    await page.getByLabel("대화 파일").setInputFiles(zip);
    await expect(page.getByText("메시지 11개")).toBeVisible();
    expect(violations).toEqual([]);
  });

  test("/about: 쿠키 없이 열리고 보관·삭제·연락·무관·AI 고지가 있다", async ({ page }) => {
    const violations = await watchCsp(page);
    const res = await page.goto("/about");
    expect(nonceOf(res?.headers()["content-security-policy"])).toBeTruthy();
    await expect(page).toHaveURL(/\/about$/);
    for (const text of [/원본 대화 파일은 이 기기/, /Anthropic.*30일/, /30일 뒤 자동으로 지워요/, /지금 삭제/, /운영자에게 카톡/, /카카오와 무관/, /AI 생성, 재미·참고용/]) {
      await expect(page.getByText(text).first()).toBeVisible();
    }
    expect(violations).toEqual([]);
  });
});

test.describe("초대 게이트", () => {
  test("쿠키 없는 새 context로 /new·/c/x에 가면 /로 간다", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    for (const target of ["/new", "/c/x", "/c/x/e/1"]) {
      await page.goto(target);
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByLabel("초대 코드")).toBeVisible();
    }
    await context.close();
  });

  test("서명이 틀린 쿠키로 /c/x를 요청하면 307로 /에 보낸다", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL });
    await context.addCookies([{ name: SESSION_COOKIE, value: "invite.9999999999999.forged", url: baseURL! }]);
    const res = await context.request.get("/c/x", { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(new URL(res.headers().location!, baseURL).pathname).toBe("/");
    await context.close();
  });

  test("쿠키 없이 POST /api/conversations는 401", async ({ playwright, baseURL }) => {
    const api = await playwright.request.newContext({ baseURL });
    const res = await api.post("/api/conversations", { data: {} });
    expect(res.status()).toBe(401);
    await api.dispose();
  });
});
