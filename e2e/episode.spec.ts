import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { PROMPT_RESERVE_TOKENS, TOKENS_PER_CHAR } from "@/lib/config";
import { type Payload, payloadTokens } from "@/lib/payload/build";
import type { ChatMessage } from "@/lib/parse/parse";
import { computeStats } from "@/lib/stats/compute";
import { androidChat, expectNoHorizontalScroll, fakeTurnstile, login, textUpload } from "./helpers";

// 대화·상태·다시 쓰기·피드백 API는 page.route로 흉내 낸다(테스트 모드 서버에는 Claude가 없다).
// 페이지(서버 컴포넌트)의 초대 코드 확인만 진짜 세션을 쓴다.

const ID = "0b6c3f1e-2a4d-4c5b-9e8f-7a6b5c4d3e2f";
/** 413 응답의 maxTokens. 입력 예산 − 프롬프트 몫 − 통계·범례 몫이 1,000 이상 남는 값이다 */
const MAX_TOKENS_413 = 12_000;
/** 413 테스트용 긴 대화: 첫 페이로드가 재시도 예산(maxTokens × 0.95)을 넘도록 철수가 긴 메시지를 더 보낸다 */
const LONG_BODIES = Array.from({ length: 12 }, (_, i) => `${i + 1}번째 긴 이야기 ${"오늘 저녁에 뭐 먹을지 한참 고민하다가 결국 집 앞 국밥집에 갔어요 ".repeat(12)}`);
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
 * 2편 헤드라인은 모르는 경로뿐이라 채우면 빈 글이 된다. paragraph가 있으면 섹션 둘째 문단으로 넣는다
 */
function content(n: number, quote: string, statText = false, paragraph?: string) {
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
        paragraphs: [
          { key: "p1", text: "민지의 답장은 {{stat:replyMedianMs.민지}} 안에 왔어요", evidence_ids: ["e1"] },
          ...(paragraph ? [{ key: "p2", text: paragraph, evidence_ids: ["e1"] }] : []),
        ],
        evidence: [{ id: "e1", msg_id: "m1", quote, sender: "민지", at: "2026-10-01T20:04:00+09:00" }],
      },
    ],
    next_teaser: n === 4 ? null : statText ? `${n + 1}편: {{stat:replyMedianMs.민지}} 뒤의 이야기` : `${n + 1}편 예고`,
  };
}

/** 공유 API가 처음 만들 때 돌려주는 링크 */
const SHARE_URL = "http://localhost:3100/s/AAAAAAAAAAAAAAAAAAAAAA";

/** 편 상태(statuses)를 바꿔 가며 대화·상태·공유 API를 흉내 낸다. 다시 쓰기·피드백·공유 요청 본문을 모은다 */
async function fakeApi(
  context: BrowserContext,
  statuses: string[],
  o: { paused?: boolean; quote?: string; paragraph?: string; statText?: boolean; shared?: boolean } = {},
) {
  const api = {
    statuses: [...statuses],
    paused: o.paused ?? false,
    retries: [] as unknown[],
    feedback: [] as unknown[],
    deleted: 0,
    share: { shared: o.shared ?? false, scope: (o.shared ? "all" : null) as string | null, hidden: [] as number[] },
    sharePosts: [] as unknown[],
    shareDeletes: [] as unknown[],
    /** 다음 POST /api/shares 하나를 이 상태로 돌려준다(동시 변경 409 등) */
    shareReply: null as number | null,
  };
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
        shared: api.share.shared,
        shareScope: api.share.scope,
        shareHidden: api.share.hidden,
        episodes: api.statuses.map((status, i) => ({
          n: i + 1,
          status,
          content: hasContent(status) ? content(i + 1, o.quote ?? "집에서 쉬는 중", o.statText, o.paragraph) : null,
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
                  ...(o.paragraph ? [{ range: "10-06~10-07", note: o.paragraph }] : []),
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
  // shares.ts와 같다: 처음 만들면 {url}, 이미 공유 중이면 {url: null}, DELETE는 204(범위·숨김은 남긴다)
  await context.route("**/api/shares", (route) => {
    const body = route.request().postDataJSON() as { scope: string; hidden: number[] };
    if (route.request().method() === "DELETE") {
      api.shareDeletes.push(body);
      api.share.shared = false;
      return route.fulfill({ status: 204 });
    }
    api.sharePosts.push(body);
    const reply = api.shareReply;
    api.shareReply = null;
    if (reply !== null) return route.fulfill({ status: reply, json: { error: "conflict" } });
    const issued = !api.share.shared;
    api.share = { shared: true, scope: body.scope, hidden: body.hidden };
    return route.fulfill({ json: { url: issued ? SHARE_URL : null, shared: true } });
  });
  return api;
}

/** POST /api/conversations를 흉내 낸다. replies 차례로 413 {maxTokens} 또는 202 {id} */
async function fakeCreate(page: Page, replies: (202 | 413)[] = [202]) {
  const posts: Record<string, unknown>[] = [];
  await page.route("**/api/conversations", (route) => {
    posts.push(route.request().postDataJSON());
    return replies.shift() === 413
      ? route.fulfill({ status: 413, json: { maxTokens: MAX_TOKENS_413 } })
      : route.fulfill({ status: 202, json: { id: ID } });
  });
  return posts;
}

const next = (page: Page) => page.getByRole("button", { name: "다음", exact: true });
const create = (page: Page) => page.getByRole("button", { name: "AI 연재 만들기" });
const card = (page: Page, n: number) => page.getByRole("region", { name: `${n}편`, exact: true });

/** android-ko 픽스처를 올려 기본 이름으로 '보낼 내용 확인'까지 가고 단톡방 동의를 체크한다 */
async function toReview(page: Page, chat = androidChat()) {
  await page.goto("/new");
  await page.getByLabel("대화 파일").setInputFiles(textUpload("KakaoTalkChats.txt", chat));
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
const sentParts = (p: Record<string, unknown>) => [p.transcript, p.anchors, JSON.stringify(p.stats), JSON.stringify(p.members)];

test.describe("AI 연재", () => {
  test.beforeEach(async ({ page }) => {
    await fakeTurnstile(page);
    await login(page);
  });

  test("[AI 연재 만들기]: POST 본문(transcript·anchors·stats·members)에 원래 발신자 이름이 없고, 받으면 진행 화면으로 간다", async ({
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
    expect(body.v).toBe(2);
    expect(body.tone).toBe("fact");
    expect("me" in body).toBe(false);
    expect(body.members).toEqual(expect.arrayContaining(["멤버1", "멤버2"]));
    expect(String(body.transcript).length).toBeGreaterThan(0);
    for (const name of ORIGINAL_NAMES) {
      expect(sentParts(body).filter((part) => String(part).includes(name)), name).toEqual([]);
    }
  });

  test("만든 연재는 시작 화면의 '내 연재'에서 다시 열 수 있고, [지금 삭제]하면 목록에서 빠진다", async ({ page, context }) => {
    await fakeApi(context, ["done", "done", "done", "done"]);
    await fakeCreate(page);
    await toReview(page);
    await create(page).click();
    await expect(page).toHaveURL(`/c/${ID}/steps`);

    await page.goto("/");
    const mine = page.getByRole("region", { name: "내 연재" });
    await expect(mine.getByRole("link", { name: /연재/ })).toHaveAttribute("href", `/c/${ID}`);
    await mine.getByRole("link", { name: /연재/ }).click();
    await expect(page).toHaveURL(`/c/${ID}`);
    await page.getByRole("button", { name: "지금 삭제" }).click();
    await page.getByRole("button", { name: "정말 지우기" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("region", { name: "내 연재" })).toHaveCount(0);
  });

  test("413이면 maxTokens × 0.95로 한 번만 다시 만들어 보내고, 또 413이면 오류를 보여 준다", async ({ page, context }) => {
    await fakeApi(context, ["running", "queued", "queued", "queued"]);
    const posts = await fakeCreate(page, [413, 413, 413, 202]);
    await toReview(page, androidChat({ bodies: LONG_BODIES }));

    await create(page).click();
    await expect(page.getByRole("alert").filter({ hasText: "대화가 너무 길어서" })).toBeVisible();
    expect(posts).toHaveLength(2);
    await expect(page).toHaveURL(/\/new$/);

    // 다시 누르면 처음 페이로드부터 다시 시작한다
    await create(page).click();
    await expect(page).toHaveURL(`/c/${ID}/steps`);
    expect(posts).toHaveLength(4);
    expect(posts[2]).toEqual(posts[0]);
    // 다시 만든 페이로드는 maxTokens × 0.95 안이다(통계·범례·프롬프트 몫 포함)
    const total = (p: Record<string, unknown>) => payloadTokens(p as unknown as Payload, TOKENS_PER_CHAR).total + PROMPT_RESERVE_TOKENS;
    const limit = Math.floor(MAX_TOKENS_413 * 0.95);
    expect(total(posts[0])).toBeGreaterThan(limit);
    expect(total(posts[3])).toBeLessThanOrEqual(limit);
    expect(posts[3].transcript).not.toEqual(posts[0].transcript);
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
    await expect(again.getByText("2026-12-24 (30일 보관)")).toBeVisible();
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
    await expect(card(page, 4)).toContainText("처음 올린 그 파일을 같은 이름");
    expect(api.retries).toHaveLength(1);
  });

  test("페이로드가 없으면 [다시 쓰기]는 보내지 않고 안내하며, 정지 중에는 [다시 쓰기] 대신 마감 안내", async ({ page, context }) => {
    const api = await fakeApi(context, ["done", "failed", "partial", "done"]);
    await page.goto(`/c/${ID}`);
    await card(page, 2).getByRole("button", { name: "다시 쓰기" }).click();
    await expect(card(page, 2)).toContainText("처음 올린 그 파일을 같은 이름");
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

  test.describe("공유", () => {
    const panel = (page: Page) => page.getByRole("region", { name: "공유", exact: true });
    const NOTICE =
      "링크를 받은 사람은 초대 코드 없이 읽을 수 있어요. 인용된 대화 원문이 함께 보여요. 대화와 함께 2026-12-24에 사라져요";

    /** navigator.share가 없는 브라우저(링크 복사로 간다) */
    const withoutNativeShare = (page: Page) =>
      page.addInitScript(() => {
        delete (Navigator.prototype as { share?: unknown }).share;
      });

    /** navigator.share가 있는 브라우저. 받은 {title, url}을 window.__shared에 남긴다 */
    const withNativeShare = (page: Page) =>
      page.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, "share", {
          configurable: true,
          value: async (data: ShareData) => {
            (window as unknown as { __shared: ShareData[] }).__shared = [
              ...((window as unknown as { __shared?: ShareData[] }).__shared ?? []),
              data,
            ];
          },
        });
      });

    test("1편이 끝나야 보이고, [링크 만들기]는 링크를 복사하며, 새로 열어도 이 기기의 링크가 남고, [링크 폐기]는 한 번 더 묻고 DELETE를 보낸다", async ({
      page,
      context,
      browserName,
    }) => {
      await withoutNativeShare(page);
      // Chromium은 진짜 클립보드를 읽는다. WebKit은 권한을 줄 수 없어 writeText를 기록하는 것으로 바꾼다
      if (browserName === "chromium") {
        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      } else {
        await page.addInitScript(() => {
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { writeText: async (text: string) => void ((window as unknown as { __copied: string }).__copied = text) },
          });
        });
      }
      const copied = () =>
        browserName === "chromium"
          ? page.evaluate(() => navigator.clipboard.readText())
          : page.evaluate(() => (window as unknown as { __copied?: string }).__copied ?? "");

      const api = await fakeApi(context, ["running", "queued", "queued", "queued"]);
      await page.goto(`/c/${ID}`);
      await expect(card(page, 1)).toContainText("쓰는 중");
      await expect(panel(page)).toHaveCount(0);

      api.statuses = ["done", "running", "queued", "queued"];
      await page.reload();
      await expect(panel(page)).toContainText(NOTICE);
      await expect(panel(page).getByRole("radio", { name: "1편만" })).toBeChecked();
      // 숨김은 내용이 있는 편만 고를 수 있다
      await expect(panel(page).getByRole("checkbox", { name: "1편 숨기기" })).not.toBeChecked();
      await expect(panel(page).getByRole("checkbox", { name: "2편 숨기기" })).toHaveCount(0);

      await panel(page).getByRole("radio", { name: "4편 전체" }).check();
      await panel(page).getByRole("button", { name: "링크 만들기" }).click();
      await expect(panel(page).getByText("링크를 복사했어요")).toBeVisible();
      expect(api.sharePosts).toEqual([{ id: ID, scope: "all", hidden: [] }]);
      expect(await copied()).toBe(SHARE_URL);

      // 다시 열어도 이 브라우저가 기억한 링크로 [링크 복사]를 쓸 수 있다
      await page.reload();
      await expect(panel(page)).toContainText(SHARE_URL);
      await expect(panel(page).getByRole("radio", { name: "4편 전체" })).toBeChecked();
      await expect(panel(page).getByRole("button", { name: "카톡으로 보내기" })).toHaveCount(0);
      await expect(panel(page).getByRole("button", { name: "링크 만들기" })).toHaveCount(0);
      await panel(page).getByRole("button", { name: "링크 복사" }).click();
      await expect(panel(page).getByText("링크를 복사했어요")).toBeVisible();
      expect(api.sharePosts).toHaveLength(1);

      await panel(page).getByRole("button", { name: "링크 폐기" }).click();
      await expect(panel(page)).toContainText("이전 링크는 바로 열리지 않아요");
      expect(api.shareDeletes).toEqual([]);
      await panel(page).getByRole("button", { name: "정말 폐기" }).click();
      await expect.poll(() => api.shareDeletes).toEqual([{ id: ID }]);
      await expect(panel(page).getByRole("button", { name: "링크 만들기" })).toBeVisible();
      await expect(panel(page)).not.toContainText(SHARE_URL);
      // 폐기한 링크는 이 브라우저에서도 잊는다
      expect(await page.evaluate((id) => localStorage.getItem(`analytalk:share:${id}`), ID)).toBeNull();
    });

    test("navigator.share가 있으면 [링크 만들기]가 컨셉 제목(이름 없음)으로 공유하고, 범위·숨김을 바꾸면 [저장]은 링크를 그대로 둔다", async ({
      page,
      context,
    }) => {
      await withNativeShare(page);
      const api = await fakeApi(context, ["done", "partial", "failed", "done"]);
      await page.goto(`/c/${ID}`);
      await expect(panel(page).getByRole("checkbox", { name: "2편 숨기기" })).toBeVisible();
      await expect(panel(page).getByRole("checkbox", { name: "3편 숨기기" })).toHaveCount(0);

      await panel(page).getByRole("button", { name: "링크 만들기" }).click();
      await expect(panel(page).getByText("공유했어요")).toBeVisible();
      const shared = await page.evaluate(() => (window as unknown as { __shared?: ShareData[] }).__shared);
      expect(shared).toEqual([{ title: "연애·썸", url: SHARE_URL }]);
      expect(api.sharePosts).toEqual([{ id: ID, scope: "first", hidden: [] }]);

      await expect(panel(page).getByRole("button", { name: "카톡으로 보내기" })).toBeVisible();
      await expect(panel(page).getByRole("button", { name: "저장" })).toHaveCount(0);
      await panel(page).getByRole("checkbox", { name: "2편 숨기기" }).check();
      await panel(page).getByRole("radio", { name: "4편 전체" }).check();
      await panel(page).getByRole("button", { name: "저장" }).click();
      await expect(panel(page).getByText("저장했어요")).toBeVisible();
      expect(api.sharePosts.at(-1)).toEqual({ id: ID, scope: "all", hidden: [2] });
      // 응답 url이 null이어도 기억해 둔 링크를 그대로 보여 준다
      await expect(panel(page)).toContainText(SHARE_URL);
      await expect(panel(page).getByRole("button", { name: "저장" })).toHaveCount(0);

      await panel(page).getByRole("button", { name: "카톡으로 보내기" }).click();
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { __shared?: ShareData[] }).__shared?.length))
        .toBe(2);
    });

    test("다른 기기에서 만든 링크면 안내만 하고, 저장이 409면 대화를 다시 읽고 다시 시도하라고 한다", async ({ page, context }) => {
      await withoutNativeShare(page);
      const api = await fakeApi(context, ["done", "done", "done", "done"], { shared: true });
      await page.goto(`/c/${ID}`);
      await expect(panel(page)).toContainText("이 기기에서 만든 링크가 아니에요. 새 링크가 필요하면 폐기 후 다시 만드세요");
      await expect(panel(page).getByRole("button", { name: "링크 복사" })).toHaveCount(0);
      await expect(panel(page).getByRole("radio", { name: "4편 전체" })).toBeChecked();

      await panel(page).getByRole("radio", { name: "1편만" }).check();
      api.shareReply = 409;
      // 다른 곳에서 폐기됐다
      api.share.shared = false;
      await panel(page).getByRole("button", { name: "저장" }).click();
      await expect(panel(page).getByText("다른 곳에서 바뀌었어요. 다시 시도해 주세요")).toBeVisible();
      await expect(panel(page).getByRole("button", { name: "링크 만들기" })).toBeVisible();
      expect(api.sharePosts).toEqual([{ id: ID, scope: "first", hidden: [] }]);
    });
  });

  test.describe("375px", () => {
    test.use({ viewport: { width: 375, height: 812 } });

    // keep-all이라 띄어 쓰지 않은 긴 글(ㅋ 줄, 붙여 쓴 문장)은 끊을 곳이 없는 한 단어다. 카드 밖으로 잘리지 않고 줄이 바뀌어야 한다
    test("진행·대화 홈·편 화면에 가로 스크롤이 없고, 띄어 쓰지 않은 긴 글도 잘리지 않는다", async ({ page, context }) => {
      await fakeApi(context, ["done", "running", "failed", "queued"], {
        quote: `${"ㅋ".repeat(40)}\n${"긴인용문".repeat(40)} ${XSS}`,
        paragraph: `웃음은 이렇게 이어졌어요 ${"ㅋ".repeat(30)} 그리고${"아진짜너무웃기다그거어디서봤어".repeat(3)}`,
      });
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

    test("공유 중이라 긴 링크가 보여도 대화 홈에 가로 스크롤이 없다", async ({ page, context }) => {
      const long = `https://${"long-subdomain-".repeat(4)}analytalk.example.com/s/AAAAAAAAAAAAAAAAAAAAAA`;
      await page.addInitScript(([id, url]) => localStorage.setItem(`analytalk:share:${id}`, url), [ID, long]);
      await fakeApi(context, ["done", "done", "done", "done"], { shared: true });
      await page.goto(`/c/${ID}`);
      await expect(page.getByRole("region", { name: "공유", exact: true })).toContainText(long);
      await expectNoHorizontalScroll(page);
    });
  });
});
