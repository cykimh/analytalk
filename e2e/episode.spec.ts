import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import type { ChatMessage } from "@/lib/parse/parse";
import { computeStats } from "@/lib/stats/compute";
import { androidChat, expectNoHorizontalScroll, fakeTurnstile, login, textUpload } from "./helpers";

// 대화·상태·다시 쓰기·피드백 API는 page.route로 흉내 낸다(테스트 모드 서버에는 Claude가 없다).
// 페이지(서버 컴포넌트)의 초대 코드 확인만 진짜 세션을 쓴다.

const ID = "0b6c3f1e-2a4d-4c5b-9e8f-7a6b5c4d3e2f";
const XSS = "<img src=x onerror=alert(1)>";
/** android-ko 픽스처의 원래 발신자 이름("민지, 수아" 포함)과 초대 알림의 이름 */
const ORIGINAL_NAMES = ["민지", "철수", "수아", "영희"];

const kst = (d: number, h: number, mi: number) => Date.UTC(2026, 9, d, h, mi) - 9 * 3_600_000;
/** 표시 이름 민지·철수의 가짜 대화 통계. 민지는 늘 4분 뒤 답한다 */
const messages: ChatMessage[] = [1, 2, 3].flatMap((d, i) => [
  { id: i * 2, ts: kst(d, 20, 0), sender: "철수", kind: "text" as const, text: "오늘 뭐해?", line: i * 2 + 1 },
  { id: i * 2 + 1, ts: kst(d, 20, 4), sender: "민지", kind: "text" as const, text: "집에서 쉬는 중", line: i * 2 + 2 },
]);
const stats = computeStats(messages);

/**
 * 저장된 편. statText면 문단 밖 글(헤드라인·dek·섹션 제목·예고·메모)에도 {{stat:…}}을 넣는다.
 * 2편 헤드라인은 모르는 경로뿐이라 채우면 빈 글이 된다
 */
function content(n: number, quote: string, statText = false) {
  return {
    episode: n,
    safety: { flag: "none" },
    declined_topics: [],
    reading_notes: [{ range: "10-01~10-03", note: statText ? "{{stat:total}}개를 읽었다" : "저녁마다 이야기했다" }],
    headline: !statText ? `${n}편 헤드라인` : n === 2 ? "{{stat:nope}}" : `${n}편 민지의 {{stat:replyMedianMs.민지}} 법칙`,
    dek: statText ? "{{stat:longestStreakDays}} 동안의 흐름" : "사흘 동안의 흐름",
    sections: [
      {
        icon: "🌙",
        title: statText ? "{{stat:total}}번의 저녁{{stat:nope}}" : "저녁의 리듬",
        about: "pair",
        paragraphs: [{ key: "p1", text: "민지의 답장은 {{stat:replyMedianMs.민지}} 안에 왔어요", evidence_ids: ["e1"] }],
        evidence: [{ id: "e1", msg_id: "m1", quote, sender: "민지", at: "2026-10-01T20:04:00+09:00" }],
      },
    ],
    next_teaser: n === 4 ? null : statText ? `${n + 1}편: {{stat:replyMedianMs.민지}} 뒤의 이야기` : `${n + 1}편 예고`,
  };
}

/** 편 상태(statuses)를 바꿔 가며 대화·상태 API를 흉내 낸다. 다시 쓰기·피드백 요청 본문을 모은다 */
async function fakeApi(
  context: BrowserContext,
  statuses: string[],
  o: { paused?: boolean; quote?: string; statText?: boolean } = {},
) {
  const api = { statuses: [...statuses], paused: o.paused ?? false, retries: [] as unknown[], feedback: [] as unknown[], deleted: 0 };
  const hasContent = (s: string) => s === "done" || s === "partial";
  const note = o.statText ? "{{stat:total}}개를 {{stat:nope}}읽었다" : "저녁마다 이야기했다";
  await context.route(`**/api/conversations/${ID}`, (route) => {
    if (route.request().method() === "DELETE") {
      api.deleted++;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({
      json: {
        concept: "couple",
        kind: "pair",
        displayNames: ["철수", "민지"],
        stats,
        cutoffAt: "2026-09-30T15:00:00.000Z",
        msgSent: messages.length,
        expiresAt: "2026-12-24T03:00:00.000Z",
        shareScope: null,
        shareHidden: [],
        episodes: api.statuses.map((status, i) => ({
          n: i + 1,
          status,
          content: hasContent(status) ? content(i + 1, o.quote ?? "집에서 쉬는 중", o.statText) : null,
          errorCode: status === "failed" ? "retryable" : null,
        })),
      },
    });
  });
  await context.route(`**/api/conversations/${ID}/status`, (route) =>
    route.fulfill({
      json: {
        episodes: api.statuses.map((status, i) => ({
          n: i + 1,
          status,
          progress:
            status === "queued"
              ? null
              : [
                  { range: "10-01~10-03", note: `${i + 1}편 메모: ${note}` },
                  ...(o.statText ? [{ range: "10-04~10-05", note: "{{stat:nope}}" }] : []),
                ],
          errorCode: status === "failed" ? "retryable" : null,
        })),
        paused: api.paused,
      },
    }),
  );
  await context.route("**/api/episodes/retry", (route) => {
    const body = route.request().postDataJSON() as { n: number };
    api.retries.push(body);
    api.statuses[body.n - 1] = "running";
    return route.fulfill({ status: 202 });
  });
  await context.route("**/api/feedback", (route) => {
    api.feedback.push(route.request().postDataJSON());
    return route.fulfill({ status: 204 });
  });
  return api;
}

/** POST /api/conversations를 흉내 낸다. replies 차례로 413 {maxTokens} 또는 202 {id} */
async function fakeCreate(page: Page, replies: (202 | 413)[] = [202]) {
  const posts: Record<string, unknown>[] = [];
  await page.route("**/api/conversations", (route) => {
    posts.push(route.request().postDataJSON());
    return replies.shift() === 413
      ? route.fulfill({ status: 413, json: { maxTokens: 200 } })
      : route.fulfill({ status: 202, json: { id: ID } });
  });
  return posts;
}

const next = (page: Page) => page.getByRole("button", { name: "다음", exact: true });
const create = (page: Page) => page.getByRole("button", { name: "AI 연재 만들기" });
const card = (page: Page, n: number) => page.getByRole("region", { name: `${n}편`, exact: true });

/** android-ko 픽스처를 올려 기본 이름으로 '보낼 내용 확인'까지 가고 단톡방 동의를 체크한다 */
async function toReview(page: Page) {
  await page.goto("/new");
  await page.getByLabel("대화 파일").setInputFiles(textUpload("KakaoTalkChats.txt", androidChat()));
  await next(page).click();
  await page.getByRole("radio", { name: "민지", exact: true }).check();
  await next(page).click();
  await expect(page.getByRole("heading", { name: "이름 정리" })).toBeVisible();
  await next(page).click();
  await expect(page.getByRole("heading", { name: "대화 통계" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "보낼 내용 확인" }).click();
  await expect(create(page)).toBeDisabled();
  await page.getByRole("checkbox", { name: "방 사람들에게 말했어요" }).check();
  await expect(create(page)).toBeEnabled();
}

/** 화면이 보내는 페이로드 중 모델·서버가 보는 부분 */
const sentParts = (p: Record<string, unknown>) => [p.transcript, p.anchors, JSON.stringify(p.stats), JSON.stringify(p.members), p.me];

test.describe("AI 연재", () => {
  test.beforeEach(async ({ page }) => {
    await fakeTurnstile(page);
    await login(page);
  });

  test("[AI 연재 만들기]: POST 본문(transcript·anchors·stats·members·me)에 원래 발신자 이름이 없고, 받으면 진행 화면으로 간다", async ({
    page,
    context,
  }) => {
    await fakeApi(context, ["running", "queued", "queued", "queued"]);
    const posts = await fakeCreate(page);
    await toReview(page);
    await create(page).click();
    await expect(page).toHaveURL(`/c/${ID}/steps`);

    expect(posts).toHaveLength(1);
    const body = posts[0];
    expect(body.me).toBe("멤버1");
    expect(body.members).toEqual(expect.arrayContaining(["멤버1", "멤버2"]));
    expect(String(body.transcript).length).toBeGreaterThan(0);
    for (const name of ORIGINAL_NAMES) {
      expect(sentParts(body).filter((part) => String(part).includes(name)), name).toEqual([]);
    }
  });

  test("413이면 maxTokens × 0.95로 한 번만 다시 만들어 보내고, 또 413이면 오류를 보여 준다", async ({ page, context }) => {
    await fakeApi(context, ["running", "queued", "queued", "queued"]);
    const posts = await fakeCreate(page, [413, 413, 413, 202]);
    await toReview(page);

    await create(page).click();
    await expect(page.getByRole("alert").filter({ hasText: "대화가 너무 길어서" })).toBeVisible();
    expect(posts).toHaveLength(2);
    await expect(page).toHaveURL(/\/new$/);

    // 다시 누르면 처음 페이로드부터 다시 시작한다
    await create(page).click();
    await expect(page).toHaveURL(`/c/${ID}/steps`);
    expect(posts).toHaveLength(4);
    expect(posts[2]).toEqual(posts[0]);
    const textTokens = (p: Record<string, unknown>) =>
      (p.anchors === "" ? 0 : String(p.anchors).length + 1) + String(p.transcript).length + 1;
    expect(textTokens(posts[0])).toBeGreaterThan(200);
    expect(textTokens(posts[3])).toBeLessThanOrEqual(Math.floor(200 * 0.95));
    expect(posts[3].stats).toEqual(posts[0].stats);
  });

  test("진행 화면: 편별 메모를 쌓고 생각하는 동안 통계를 돌려 보여 주다가, 1편이 끝나면 [1편 읽기]", async ({ page, context }) => {
    const api = await fakeApi(context, ["running", "queued", "queued", "queued"]);
    await page.goto(`/c/${ID}/steps`);
    await expect(page.getByText("1편 메모: 저녁마다 이야기했다")).toBeVisible();
    const stat = page.getByRole("region", { name: "기다리는 동안 볼 통계" });
    await expect(stat).toContainText("메시지6개");
    await expect(stat).toContainText("가장 많이 보낸 사람", { timeout: 10_000 });
    await expect(page.getByRole("link", { name: "1편 읽기" })).toHaveCount(0);

    api.statuses = ["done", "running", "running", "running"];
    await expect(page.getByRole("link", { name: "1편 읽기" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("2편 메모: 저녁마다 이야기했다")).toBeVisible();
    await expect(page.getByText("1편 메모: 저녁마다 이야기했다")).toBeVisible();

    await page.getByRole("link", { name: "1편 읽기" }).click();
    await expect(page).toHaveURL(`/c/${ID}/e/1`);
    await expect(page.getByRole("heading", { name: "1편 헤드라인" })).toBeVisible();
    await expect(page.getByRole("article")).toContainText("민지의 답장은 4분 안에 왔어요");
  });

  test("탭을 닫았다 다시 열어도 /c/[id]가 상태를 불러와 끝난 편부터 보여 준다", async ({ page, context }) => {
    const api = await fakeApi(context, ["done", "running", "queued", "queued"]);
    await page.goto(`/c/${ID}/steps`);
    await expect(page.getByRole("link", { name: "1편 읽기" })).toBeVisible();
    await page.close();

    const again = await context.newPage();
    await again.goto(`/c/${ID}`);
    await expect(card(again, 1)).toContainText("1편 헤드라인");
    await expect(card(again, 1).getByRole("link", { name: "1편 읽기" })).toBeVisible();
    await expect(card(again, 2)).toContainText("쓰는 중");
    await expect(card(again, 3)).toContainText("기다리는 중");
    await expect(again.getByText("2026-10-01 이후 6개")).toBeVisible();
    await expect(again.getByText(/2026-12-24/)).toBeVisible();
    await expect(again.getByText("AI 생성, 재미·참고용")).toBeVisible();

    api.statuses = ["done", "done", "running", "running"];
    await expect(card(again, 2).getByRole("link", { name: "2편 읽기" })).toBeVisible({ timeout: 10_000 });
    await expect(card(again, 2)).toContainText("2편 헤드라인");

    // [지금 삭제]는 한 번 더 묻고 지운 뒤 처음 화면으로 간다
    await again.getByRole("button", { name: "지금 삭제" }).click();
    expect(api.deleted).toBe(0);
    await again.getByRole("button", { name: "정말 지우기" }).click();
    await expect(again).toHaveURL(/\/$/);
    expect(api.deleted).toBe(1);
  });

  test("failed 편 [다시 쓰기]는 이 브라우저에 둔 페이로드로 retry를 부르고, 4편이 모두 끝나면 페이로드를 지운다", async ({
    page,
    context,
  }) => {
    const api = await fakeApi(context, ["failed", "queued", "queued", "queued"]);
    const posts = await fakeCreate(page);
    await toReview(page);
    await create(page).click();
    await expect(page).toHaveURL(`/c/${ID}/steps`);
    await expect(page.getByText("1편을 쓰지 못했어요")).toBeVisible();

    await page.goto(`/c/${ID}`);
    await card(page, 1).getByRole("button", { name: "다시 쓰기" }).click();
    await expect.poll(() => api.retries.length).toBe(1);
    expect(api.retries[0]).toEqual({ id: ID, n: 1, payload: posts[0] });
    await expect(card(page, 1)).toContainText("쓰는 중");

    // 4편이 모두 끝난 것을 본 뒤에는 이 브라우저에 페이로드가 없다
    api.statuses = ["done", "done", "done", "done"];
    await expect(card(page, 4).getByRole("link", { name: "4편 읽기" })).toBeVisible({ timeout: 10_000 });
    api.statuses = ["done", "done", "done", "failed"];
    await page.reload();
    await card(page, 4).getByRole("button", { name: "다시 쓰기" }).click();
    await expect(card(page, 4)).toContainText("같은 파일을 다시 올려 주세요");
    expect(api.retries).toHaveLength(1);
  });

  test("페이로드가 없으면 [다시 쓰기]는 보내지 않고 안내하며, 정지 중에는 [다시 쓰기] 대신 마감 안내", async ({ page, context }) => {
    const api = await fakeApi(context, ["done", "failed", "partial", "done"]);
    await page.goto(`/c/${ID}`);
    await card(page, 2).getByRole("button", { name: "다시 쓰기" }).click();
    await expect(card(page, 2)).toContainText("같은 파일을 다시 올려 주세요");
    expect(api.retries).toHaveLength(0);
    // partial 편은 읽을 수도 있다
    await expect(card(page, 3).getByRole("link", { name: "3편 읽기" })).toBeVisible();

    api.paused = true;
    await page.reload();
    await expect(card(page, 2)).toContainText("이번 달 AI 마감");
    await expect(page.getByRole("button", { name: "다시 쓰기" })).toHaveCount(0);
  });

  test("편 화면: quote의 HTML은 글자로만 보이고 dialog가 뜨지 않으며, 문단 [틀렸어요]가 피드백을 보낸다", async ({ page, context }) => {
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    const api = await fakeApi(context, ["done", "done", "done", "done"], { quote: XSS });
    await page.goto(`/c/${ID}/e/1`);
    await expect(page.getByText(XSS)).toBeVisible();
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    await expect(page.getByText("AI 생성, 재미·참고용")).toBeVisible();
    // 헤드라인 → dek → 섹션 → 근거(표시 이름·시각·quote) → 예고
    const text = (await page.getByRole("article").innerText()).replace(/\s+/g, " ");
    const at = ["1편 헤드라인", "사흘 동안의 흐름", "저녁의 리듬", "민지의 답장은 4분 안에 왔어요", "2026-10-01 20:04", XSS, "2편 예고"].map(
      (s) => text.indexOf(s),
    );
    expect(at.every((x) => x >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    await expect(page.getByRole("figure")).toContainText(/민지\s*·\s*2026-10-01 20:04/);

    await page.getByRole("button", { name: "틀렸어요" }).click();
    await page.getByRole("button", { name: "사실과 달라요" }).click();
    await expect(page.getByText("알려 줘서 고마워요")).toBeVisible();
    expect(api.feedback).toEqual([{ id: ID, n: 1, paragraphKey: "s1.p1", reason: "wrong_fact" }]);
    expect(dialogs).toEqual([]);
  });

  test("문단 밖의 {{stat:…}}도 채운다: 진행 메모·카드 헤드라인·헤드라인·dek·섹션 제목·예고, 모르는 경로는 빼고 빈 헤드라인은 'N편'", async ({
    page,
    context,
  }) => {
    const api = await fakeApi(context, ["running", "queued", "queued", "queued"], { statText: true });
    const bodyText = () => page.locator("body").innerText();

    await page.goto(`/c/${ID}/steps`);
    await expect(page.getByText("1편 메모: 6개를 읽었다")).toBeVisible();
    // 채운 뒤 빈 메모는 날짜 범위까지 그리지 않는다
    await expect(page.getByText("10-04~10-05")).toHaveCount(0);
    expect(await bodyText()).not.toContain("{{");

    api.statuses = ["done", "done", "done", "done"];
    await page.goto(`/c/${ID}`);
    await expect(card(page, 1).getByRole("heading")).toHaveText("1편 민지의 4분 법칙");
    await expect(card(page, 2).getByRole("heading")).toHaveText("2편");
    expect(await bodyText()).not.toContain("{{");

    await page.goto(`/c/${ID}/e/1`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("1편 민지의 4분 법칙");
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(/6번의 저녁$/);
    const article = page.getByRole("article");
    await expect(article).toContainText("3일 동안의 흐름");
    await expect(article).toContainText("민지의 답장은 4분 안에 왔어요");
    await expect(article).toContainText("2편: 4분 뒤의 이야기");
    expect(await bodyText()).not.toMatch(/\{\{|stat:/);

    await page.goto(`/c/${ID}/e/2`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("2편");
    expect(await bodyText()).not.toMatch(/\{\{|stat:/);
  });

  test.describe("375px", () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test("진행·대화 홈·편 화면에 가로 스크롤이 없다", async ({ page, context }) => {
      await fakeApi(context, ["done", "running", "failed", "queued"], { quote: `${"긴인용문".repeat(40)} ${XSS}` });
      await page.goto(`/c/${ID}/steps`);
      await expect(page.getByRole("link", { name: "1편 읽기" })).toBeVisible();
      await expectNoHorizontalScroll(page);
      await page.goto(`/c/${ID}`);
      await expect(card(page, 1)).toContainText("1편 헤드라인");
      await expectNoHorizontalScroll(page);
      await page.goto(`/c/${ID}/e/1`);
      await expect(page.getByRole("heading", { name: "1편 헤드라인" })).toBeVisible();
      await expectNoHorizontalScroll(page);
    });
  });
});
