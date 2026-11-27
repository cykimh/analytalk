import { expect, test } from "@playwright/test";
import { expectNoHorizontalScroll } from "./helpers";

// v2.8 /demo: 초대 코드 없이(쿠키 없음) 보는 데모 리포트. 가짜 단톡방으로 만든 정적 리포트라 API를 부르지 않는다

test("처음 화면과 안내 페이지에서 [데모 리포트 보기]로 초대 코드 없이 /demo를 연다", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "데모 리포트 보기" }).click();
  await expect(page).toHaveURL("/demo");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("저녁 메뉴로 시작해 새벽 라면으로 끝나는 방에 하는 잔소리");
  await page.goto("/about");
  await page.getByRole("link", { name: "데모 리포트 보기" }).click();
  await expect(page).toHaveURL("/demo");
});

test("/demo: noindex(메타·헤더), 데모 안내, 하이라이트 6장(케미 온도부터)·ㅋ 유형·MBTI 칩, 테이프 1개·h1 1개, [나도 해보기]는 바깥", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  const res = await page.goto("/demo");
  expect(res!.status()).toBe(200);
  expect(res!.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
  await expect(page.getByRole("note")).toContainText("가짜 단톡방");

  const highlights = page.getByRole("region", { name: "한 줄 하이라이트" });
  await expect(highlights.locator("dt")).toHaveCount(6);
  await expect(highlights.locator("dt").first()).toHaveText(/케미 온도$/);
  await expect(highlights.locator("dd").first()).toHaveText("87°");
  await expect(highlights).toContainText("ㅋ 폭격기 1위");

  for (const [name, laugh, mbti] of [
    ["민지", "ㅋ 폭발형", "MBTI ENFP"],
    ["영희", "ㅋ 광기형", "MBTI ESFP"],
    ["철수", "ㅋ 절제형", "MBTI ISTP"],
    ["지훈", "ㅋ 정석형", "MBTI ENFJ"],
    ["수아", "ㅋ 무표정형", "MBTI ISTJ"],
  ]) {
    await expect(page.getByRole("list", { name: `${name}의 유형` }).getByRole("listitem")).toHaveText([laugh, mbti]);
  }
  const groups = page.getByRole("group");
  await expect(groups).toHaveCount(3);
  await expect(page.locator(".tape")).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  // 버튼·링크는 #report-capture 바깥
  await expect(page.locator("#report-capture").getByRole("button")).toHaveCount(0);
  await expect(page.locator("#report-capture").getByRole("link")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "나도 해보기" })).toBeVisible();
  // 서버 API를 부르지 않는다
  expect(requests.filter((u) => new URL(u).pathname.startsWith("/api/"))).toEqual([]);
});

test.describe("375px", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("/demo에 가로 스크롤이 없고 글이 잘리지 않는다", async ({ page }) => {
    await page.goto("/demo");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});
