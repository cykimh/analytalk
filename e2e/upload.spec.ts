import { expect, type Page, test } from "@playwright/test";
import { E2E_INVITE_CODE } from "@/lib/config";
import {
  androidChat,
  expectNoHorizontalScroll,
  fakeTurnstile,
  login,
  recordOutgoing,
  textUpload,
  UNIQUE_SENTENCE,
  zipUpload,
} from "./helpers";

const next = (page: Page) => page.getByRole("button", { name: "다음", exact: true });

async function upload(page: Page, file: Parameters<ReturnType<Page["getByLabel"]>["setInputFiles"]>[0]) {
  await page.goto("/new");
  await page.getByLabel("대화 파일").setInputFiles(file);
}

/** 확인 → 나는 누구? → 이름 정리(기본 이름) → 방 종류·말투 → 보낼 내용 확인까지 */
async function toReview(page: Page) {
  await next(page).click();
  await expect(page.getByRole("heading", { name: "나는 누구?" })).toBeVisible();
  await page.getByRole("radio", { name: "민지", exact: true }).check();
  await next(page).click();
  await expect(page.getByRole("heading", { name: "이름 정리" })).toBeVisible();
  await next(page).click();
  await expect(page.getByRole("heading", { name: "방 종류와 말투" })).toBeVisible();
  await next(page).click();
  await expect(page.getByRole("heading", { name: "보낼 내용 확인" })).toBeVisible({ timeout: 15_000 });
}

test.describe("업로드 흐름", () => {
  test.beforeEach(async ({ page }) => {
    await fakeTurnstile(page);
    await login(page);
  });

  test("android-ko를 올리면 메시지 수가 보이고, 고유 문장은 나간 요청 어디에도 없다", async ({ page }) => {
    const sent = recordOutgoing(page);
    await upload(page, textUpload("KakaoTalkChats.txt", androidChat()));
    await expect(page.getByText("메시지 11개")).toBeVisible();
    await expect(page.getByText("인식률 100%")).toBeVisible();
    await expect(page.getByText(/인식하지 못한 줄이 있어요/)).toHaveCount(0);

    await toReview(page);
    await expect(page.getByText(/미국 Anthropic으로 가요/)).toBeVisible();
    await expect(page.getByText(/2024-03-14 이후 11개 전부/)).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "방 사람들에게 말했어요" })).toBeVisible();
    await expect(page.getByRole("button", { name: "AI 연재 만들기" })).toBeDisabled();
    // 고유 문장은 미리보기(브라우저 안)에는 있다
    await page.getByText("미리보기 20줄").click();
    await expect(page.getByText(UNIQUE_SENTENCE)).toBeVisible();

    expect(sent.length).toBeGreaterThan(0);
    expect(sent.filter((s) => s.includes(UNIQUE_SENTENCE))).toEqual([]);
    expect(sent.filter((s) => s.includes(encodeURIComponent(UNIQUE_SENTENCE)))).toEqual([]);
  });

  test("인식률이 98%보다 낮으면 경고한다", async ({ page }) => {
    await upload(page, textUpload("KakaoTalkChats.txt", androidChat({ badLines: 1 })));
    await expect(page.getByText(/인식하지 못한 줄이 있어요/)).toBeVisible();
    await expect(page.getByText(/^인식률 9\d%$/)).toBeVisible();
  });

  test("이름 정리에서 같은 이름·빈 이름·금지 문자면 [다음]을 막고 이유를 보여 준다", async ({ page }) => {
    await upload(page, textUpload("KakaoTalkChats.txt", androidChat()));
    await next(page).click();
    await page.getByRole("radio", { name: "민지", exact: true }).check();
    await next(page).click();
    await expect(page.getByRole("heading", { name: "이름 정리" })).toBeVisible();
    const minji = page.getByLabel("민지의 표시 이름", { exact: true });
    const cheolsu = page.getByLabel("철수의 표시 이름", { exact: true });
    await expect(next(page)).toBeEnabled();

    await cheolsu.fill(await minji.inputValue());
    await expect(next(page)).toBeDisabled();
    await expect(page.getByText(/두 사람에게 같은 이름/)).toBeVisible();

    await cheolsu.fill("");
    await expect(next(page)).toBeDisabled();
    await expect(page.getByText(/비어 있는 이름/)).toBeVisible();

    await cheolsu.fill("a|b");
    await expect(next(page)).toBeDisabled();
    await expect(page.getByText(/쓸 수 없는 글자/)).toBeVisible();

    await cheolsu.fill("점심왕");
    await expect(next(page)).toBeEnabled();

    // 같은 이름이어도 [같은 사람]으로 합치면 통과한다
    await cheolsu.fill(await minji.inputValue());
    await expect(next(page)).toBeDisabled();
    await page.getByLabel("철수을(를) 합칠 사람").selectOption("민지");
    await expect(page.getByText("같은 사람: 민지")).toBeVisible();
    await expect(next(page)).toBeEnabled();
  });

  test("본문은 그대로 보내고 링크는 사이트 이름만 남긴다", async ({ page }) => {
    await upload(page, textUpload("KakaoTalkChats.txt", androidChat({ bodies: ["https://www.youtube.com/watch?v=abc 봐", "민지수 왔어"] })));
    await toReview(page);
    await page.getByText("미리보기 20줄").click();
    const preview = page.locator("pre");
    await expect(preview).toContainText("[링크:youtube.com]");
    await expect(preview).not.toContainText("watch?v=abc");
    // 본문 속 이름은 바꾸지 않는다
    await expect(preview).toContainText("민지수 왔어");
    await expect(preview).toContainText("A=민지");
  });

  test("방 종류·말투 단계: 기본 말투는 팩트 일침이고 직장·팀이면 말투를 숨긴다", async ({ page }) => {
    await upload(page, textUpload("KakaoTalkChats.txt", androidChat()));
    await next(page).click();
    await page.getByRole("radio", { name: "민지", exact: true }).check();
    await next(page).click();
    await next(page).click();
    await expect(page.getByRole("radio", { name: /팩트 일침/ })).toBeChecked();
    await expect(page.getByRole("radio", { name: /따뜻한 위로/ })).toBeVisible();
    await expect(page.getByRole("radio", { name: /예능 중계/ })).toBeVisible();
    await page.getByRole("radio", { name: /직장·팀/ }).check();
    await expect(page.getByRole("radio", { name: /팩트 일침/ })).toHaveCount(0);
  });

  test.describe("카카오톡 인앱 브라우저", () => {
    test.use({
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.4.5",
    });

    test("외부 브라우저로 열라는 배너를 보여 준다", async ({ page }) => {
      await page.goto("/new");
      const open = page.getByRole("link", { name: "외부 브라우저로 열기" });
      await expect(open).toBeVisible();
      await expect(open).toHaveAttribute("href", `kakaotalk://web/openExternal?url=${encodeURIComponent(page.url())}`);
    });
  });

  test("zip 업로드도 파싱된다", async ({ page }) => {
    const zip = await zipUpload("Kakaotalk_Chat_테스트방.zip", [
      ["Kakaotalk_Chat_테스트방/KakaoTalkChats.txt", androidChat()],
      ["Kakaotalk_Chat_테스트방/photo.jpg", "not an image"],
    ]);
    await upload(page, zip);
    await expect(page.getByText("메시지 11개")).toBeVisible();
  });

  test.describe("375px", () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test("단계마다 가로 스크롤이 없다", async ({ page }) => {
      await page.goto("/new");
      await expectNoHorizontalScroll(page);
      await page.getByLabel("대화 파일").setInputFiles(textUpload("KakaoTalkChats.txt", androidChat({ bodies: ["민지수 왔어"] })));
      await expect(page.getByText("메시지 12개")).toBeVisible();
      await expectNoHorizontalScroll(page);
      await next(page).click();
      await page.getByRole("radio", { name: "민지", exact: true }).check();
      await expectNoHorizontalScroll(page);
      await next(page).click();
      await expect(page.getByRole("heading", { name: "이름 정리" })).toBeVisible();
      await expectNoHorizontalScroll(page);
      await next(page).click();
      await expect(page.getByRole("heading", { name: "방 종류와 말투" })).toBeVisible();
      await expectNoHorizontalScroll(page);
      await next(page).click();
      await expect(page.getByRole("heading", { name: "보낼 내용 확인" })).toBeVisible({ timeout: 15_000 });
      await expectNoHorizontalScroll(page);
      await page.getByText("미리보기 20줄").click();
      await expectNoHorizontalScroll(page);
    });
  });
});

test.describe("초대 코드", () => {
  test.beforeEach(async ({ page }) => {
    await fakeTurnstile(page);
  });

  test("쿠키가 없으면 코드를 받고, 맞으면 [대화 올리기]로 간다", async ({ page }) => {
    await page.goto("/");
    const submit = page.getByRole("button", { name: "들어가기" });
    await page.getByLabel("초대 코드").fill("WRONGCODE1");
    await page.getByRole("button", { name: "가짜 확인" }).click();
    await submit.click();
    await expect(page.getByText("코드가 맞지 않아요")).toBeVisible();

    // 토큰은 한 번만 쓸 수 있어 실패하면 다시 확인해야 보낼 수 있다
    await page.getByLabel("초대 코드").fill(E2E_INVITE_CODE.toLowerCase());
    await expect(submit).toBeDisabled();
    await page.getByRole("button", { name: "가짜 확인" }).click();
    await submit.click();
    await expect(page).toHaveURL(/\/new$/);
    await expect(page.getByLabel("대화 파일")).toBeAttached();

    await page.goto("/");
    await expect(page.getByRole("link", { name: "대화 올리기" })).toBeVisible();
  });

  test("쿠키 없이 /new에 오면 /로 돌려보낸다", async ({ page }) => {
    await page.goto("/new");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByLabel("초대 코드")).toBeVisible();
  });
});
