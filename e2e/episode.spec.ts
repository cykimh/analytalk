import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { PROMPT_RESERVE_TOKENS, TOKENS_PER_CHAR } from "@/lib/config";
import { type Payload, payloadTokens } from "@/lib/payload/build";
import type { ChatMessage } from "@/lib/parse/parse";
import { computeStats } from "@/lib/stats/compute";
import { androidChat, excludeMember, expectNoHorizontalScroll, fakeTurnstile, login, textUpload } from "./helpers";

// 대화·상태·다시 쓰기·공유 API는 page.route로 흉내 낸다(테스트 모드 서버에는 Claude가 없다).
// 페이지(서버 컴포넌트)의 초대 코드 확인만 진짜 세션을 쓴다.

const ID = "0b6c3f1e-2a4d-4c5b-9e8f-7a6b5c4d3e2f";
/** 413 응답의 maxTokens. 입력 예산 − 프롬프트 몫 − 통계·범례 몫이 1,000 이상 남는 값이다(v2.4: 프롬프트 몫 9,000이라 12,000 → 13,000) */
const MAX_TOKENS_413 = 13_000;
/** 413 테스트용 긴 대화: 첫 페이로드가 재시도 예산(maxTokens × 0.95)을 넘도록 철수가 긴 메시지를 더 보낸다 */
const LONG_BODIES = Array.from({ length: 12 }, (_, i) => `${i + 1}번째 긴 이야기 ${"오늘 저녁에 뭐 먹을지 한참 고민하다가 결국 집 앞 국밥집에 갔어요 ".repeat(12)}`);
const XSS = "<img src=x onerror=alert(1)>";
/** 영희를 분석에서 뺄 때 영희가 쓴 고유 문장이 든 줄(픽스처에 없는 한 줄) */
const YOUNGHEE_LINE = "2024년 3월 15일 오전 9:30, 영희 : 영희만의고유문장";

const kst = (d: number, h: number, mi: number) => Date.UTC(2026, 9, d, h, mi) - 9 * 3_600_000;
/** 표시 이름 민지·철수의 가짜 대화 통계. 민지는 늘 4분 뒤 답한다 */
const messages: ChatMessage[] = [1, 2, 3].flatMap((d, i) => [
  { id: i * 2, ts: kst(d, 20, 0), sender: "철수", kind: "text" as const, text: "오늘 뭐해?", line: i * 2 + 1 },
  { id: i * 2 + 1, ts: kst(d, 20, 4), sender: "민지", kind: "text" as const, text: "집에서 쉬는 중", line: i * 2 + 2 },
]);
const stats = computeStats(messages);

/**
 * 저장된 리포트. statText면 문단 밖 글(헤드라인·dek·섹션 제목·메모)에도 {{stat:…}}을 넣는다.
 * emptyHeadline이면 헤드라인이 모르는 경로뿐이라 채우면 빈 글이 된다. paragraph가 있으면 섹션 둘째 문단으로 넣는다
 */
function content(quote: string, statText = false, paragraph?: string, emptyHeadline = false) {
  return {
    safety: { flag: "none" },
    declined_topics: [],
    reading_notes: [{ range: "10-01~10-03", note: statText ? "{{stat:total}}개를 읽었다" : "저녁마다 이야기했다" }],
    headline: emptyHeadline ? "{{stat:nope}}" : statText ? "민지의 {{stat:replyMedianMs.민지}} 법칙" : "리포트 헤드라인",
    dek: statText ? "{{stat:longestStreakDays}} 동안의 흐름" : "사흘 동안의 흐름",
    sections: [
      {
        part: "map",
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
  };
}

/** v2.8 저장 리포트: 케미 온도(인트로)와 민지 사람 섹션(MBTI 추측과 이유) */
function v28Content() {
  const base = content("집에서 쉬는 중");
  return {
    ...base,
    chemistry: { score: 78, line: "사흘 내내 저녁 8시에 모인 둘, {{stat:total}}개면 합격이다" },
    sections: [
      ...base.sections,
      {
        part: "nag_cards",
        icon: "🙄",
        title: "민지, 4분 만에 답하는 사람",
        about: "민지",
        paragraphs: [{ key: "p1", text: "민지는 늘 4분 뒤에 답한다.", evidence_ids: ["e1"] }],
        evidence: [{ id: "e1", msg_id: "m1", quote: "집에서 쉬는 중", sender: "민지", at: "2026-10-01T20:04:00+09:00" }],
        mbti: "INFJ",
        mbti_reason: "답은 늦지 않게, 말은 아껴서. 속으로 다 계산하는 타입이다.",
      },
    ],
  };
}

/**
 * 긴 저장 리포트: 섹션 10개 × 문단 5개, 섹션마다 근거 3개(문단 p1·p3·p5가 하나씩 처음 쓴다) = 인용 30개.
 * v2.5 나눠 쓰기를 합친 순서다: ① 인트로(nag_open·nag_room 7개) → ② 개인별(철수·민지) → ③ 마무리(nag_last).
 * checks에는 호출마다 결과·뺀 섹션 수가 있다(화면에 보이지 않는다)
 */
function longContent() {
  const body = "저녁이 되면 이 방은 다시 살아난다. 한 사람이 운을 떼면 다른 사람이 곧 받아 이어 간다. 이야기는 짧은 말로 시작해 영화 이야기로 번진다. 다 보여.";
  return {
    ...content("집에서 쉬는 중"),
    headline: "또 저녁 8시에 모인 두 사람에게 하는 잔소리",
    checks: { relinked: 1, requoted: 2, unquoted: 3, dropped_by: {}, calls: { intro: "ok", people: "ok", outro: "ok" }, off_stage: 1 },
    sections: Array.from({ length: 10 }, (_, si) => ({
      part: si === 0 ? "nag_open" : si < 7 ? "nag_room" : si < 9 ? "nag_cards" : "nag_last",
      icon: "🙄",
      title: `긴 잔소리 ${si + 1}`,
      about: si === 7 ? "철수" : si === 8 ? "민지" : "pair",
      paragraphs: Array.from({ length: 5 }, (_, pi) => ({
        key: `p${pi + 1}`,
        text: `섹션 ${si + 1}의 문단 ${pi + 1}. ${body}`,
        evidence_ids: pi % 2 === 0 ? [`e${pi / 2 + 1}`] : [],
      })),
      evidence: Array.from({ length: 3 }, (_, ei) => ({
        id: `e${ei + 1}`,
        msg_id: `m${ei}`,
        quote: `섹션 ${si + 1} 인용 ${ei + 1}`,
        sender: ei % 2 === 0 ? "철수" : "민지",
        at: "2026-10-01T20:04:00+09:00",
      })),
    })),
  };
}

/** 공유 API가 처음 만들 때 돌려주는 링크 */
const SHARE_URL = "http://localhost:3100/s/AAAAAAAAAAAAAAAAAAAAAA";

/** 리포트 상태(status)를 바꿔 가며 대화·상태·공유 API를 흉내 낸다(Task 6 계약). 다시 쓰기·공유 요청 본문을 모은다 */
async function fakeApi(
  context: BrowserContext,
  status: string,
  o: {
    paused?: boolean;
    quote?: string;
    paragraph?: string;
    statText?: boolean;
    shared?: boolean;
    emptyHeadline?: boolean;
    notes?: boolean | { range: string; note: string }[];
    tone?: string;
    long?: boolean;
    /** v2.8: 케미 온도와 사람 섹션(민지, MBTI 추측)을 더한 리포트 */
    v28?: boolean;
  } = {},
) {
  const api = {
    status,
    /** null이면 첫 메모 전(progress null) */
    progress: (o.notes === undefined || o.notes === true
      ? [{ range: "10-01~10-03", note: o.statText ? "{{stat:total}}개를 {{stat:nope}}읽었다" : "저녁마다 이야기했다" }]
      : o.notes === false
        ? null
        : o.notes) as { range: string; note: string }[] | null,
    paused: o.paused ?? false,
    retries: [] as unknown[],
    deleted: 0,
    shared: o.shared ?? false,
    sharePosts: [] as unknown[],
    shareDeletes: [] as unknown[],
    /** 다음 POST /api/shares 하나를 이 상태로 돌려준다(동시 변경 409 등) */
    shareReply: null as number | null,
  };
  const hasContent = () => api.status === "done" || api.status === "partial";
  const errorCode = () => (api.status === "failed" ? "retryable" : null);
  await context.route(`**/api/conversations/${ID}`, (route) => {
    if (route.request().method() === "DELETE") {
      api.deleted++;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({
      json: {
        concept: "couple",
        kind: "pair",
        tone: o.tone ?? "fact",
        displayNames: ["철수", "민지"],
        stats,
        cutoffAt: "2026-09-30T15:00:00.000Z",
        msgSent: messages.length,
        expiresAt: "2026-12-24T03:00:00.000Z",
        shared: api.shared,
        report: {
          status: api.status,
          content: hasContent()
            ? o.long
              ? longContent()
              : o.v28
                ? v28Content()
                : content(o.quote ?? "집에서 쉬는 중", o.statText, o.paragraph, o.emptyHeadline)
            : null,
          errorCode: errorCode(),
        },
      },
    });
  });
  await context.route(`**/api/conversations/${ID}/status`, (route) =>
    route.fulfill({
      json: {
        report: { status: api.status, progress: api.status === "queued" ? null : api.progress, errorCode: errorCode() },
        paused: api.paused,
      },
    }),
  );
  await context.route("**/api/episodes/retry", (route) => {
    api.retries.push(route.request().postDataJSON());
    api.status = "running";
    return route.fulfill({ status: 202 });
  });
  // shares.ts와 같다: 처음 만들면 {url}, 이미 공유 중이면 {url: null}, DELETE는 204
  await context.route("**/api/shares", (route) => {
    const body = route.request().postDataJSON() as unknown;
    if (route.request().method() === "DELETE") {
      api.shareDeletes.push(body);
      api.shared = false;
      return route.fulfill({ status: 204 });
    }
    api.sharePosts.push(body);
    const reply = api.shareReply;
    api.shareReply = null;
    if (reply !== null) return route.fulfill({ status: reply, json: { error: "conflict" } });
    const issued = !api.shared;
    api.shared = true;
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
const create = (page: Page) => page.getByRole("button", { name: "연재 만들기" });
/** 이 브라우저의 IndexedDB에 다시 쓰기용 페이로드가 있다(lib/client/idb: idb-keyval 기본 저장소) */
const hasPayload = (page: Page) =>
  page.evaluate(
    (id) =>
      new Promise<boolean>((resolve) => {
        const open = indexedDB.open("keyval-store");
        open.onerror = () => resolve(false);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("keyval")) {
            db.close();
            return resolve(false);
          }
          const get = db.transaction("keyval").objectStore("keyval").get(`payload:${id}`);
          get.onsuccess = () => {
            db.close();
            resolve(get.result !== undefined);
          };
          get.onerror = () => {
            db.close();
            resolve(false);
          };
        };
      }),
    ID,
  );
const reportCard = (page: Page) => page.getByRole("region", { name: "AI 리포트", exact: true });

/** 이름 단계까지 간다. exclude에 든 사람은 분석에서 뺀다 */
async function toNames(page: Page, chat = androidChat(), exclude: string[] = []) {
  await page.goto("/new");
  await page.getByLabel("대화 파일").setInputFiles(textUpload("KakaoTalkChats.txt", chat));
  await next(page).click();
  await expect(page.getByRole("heading", { name: "이름 정리" })).toBeVisible();
  for (const name of exclude) await excludeMember(page, name);
}

/** 방 종류·말투 단계까지 간다 */
async function toKind(page: Page, chat = androidChat(), exclude: string[] = []) {
  await toNames(page, chat, exclude);
  await next(page).click();
  await expect(page.getByRole("heading", { name: "방 종류와 말투" })).toBeVisible();
}

/** android-ko 픽스처를 올려 기본 이름으로 '보낼 내용 확인'까지 가고 단톡방 동의를 체크한다 */
async function toReview(page: Page, chat = androidChat(), exclude: string[] = [], tone?: string) {
  await toKind(page, chat, exclude);
  if (tone) await page.getByRole("radio", { name: new RegExp(tone) }).check();
  await next(page).click();
  await expect(page.getByRole("heading", { name: "보낼 내용 확인" })).toBeVisible({ timeout: 15_000 });
  await expect(create(page)).toBeDisabled();
  await page.getByRole("checkbox", { name: "방 사람들에게 말했어요" }).check();
  await expect(create(page)).toBeEnabled();
}

/** 화면이 보내는 페이로드 중 모델·서버가 보는 부분 */
const sentParts = (p: Record<string, unknown>) => [p.transcript, p.anchors, JSON.stringify(p.stats), JSON.stringify(p.members)];

test.describe("AI 리포트", () => {
  test.beforeEach(async ({ page }) => {
    await fakeTurnstile(page);
    await login(page);
  });

  test("[연재 만들기]: 기본 POST는 tone fact·members가 카톡 이름 그대로이고, 받으면 바로 대화 홈이 진행을 보여 준다", async ({ page, context }) => {
    await fakeApi(context, "running");
    const posts = await fakeCreate(page);
    await toReview(page);
    await create(page).click();
    await expect(page).toHaveURL(`/c/${ID}`);
    await expect(page.getByRole("heading", { name: "대화 통계" })).toBeVisible();
    await expect(reportCard(page)).toBeVisible();

    expect(posts).toHaveLength(1);
    const body = posts[0];
    expect(body.v).toBe(2);
    expect(body.tone).toBe("fact");
    expect("me" in body).toBe(false);
    expect(body.members).toEqual(["민지", "철수", "민지, 수아", "영희"]);
    expect(String(body.transcript).length).toBeGreaterThan(0);
  });

  for (const [label, tone] of [
    ["예능 MC 중계", "show"],
    ["탐정 사건 보고서", "detective"],
  ] as const) {
    test(`말투로 ${label}를 고르면 보낼 내용 확인에 그 라벨이 보이고 POST의 tone이 ${tone}다`, async ({ page, context }) => {
      await fakeApi(context, "running");
      const posts = await fakeCreate(page);
      await toReview(page, androidChat(), [], label);
      await expect(page.getByText("말투", { exact: true }).locator("..")).toContainText(label);
      await create(page).click();
      await expect(page).toHaveURL(`/c/${ID}`);
      expect(posts[0].tone).toBe(tone);
    });
  }

  test("영희를 빼면 POST 어디에도 영희의 문장·이름이 없고, 보낼 내용 확인에는 뺀 멤버로 보인다", async ({ page, context }) => {
    await fakeApi(context, "running");
    const posts = await fakeCreate(page);
    const chat = `${androidChat().trimEnd()}\n${YOUNGHEE_LINE}\n`;
    await toReview(page, chat, ["영희"]);
    await expect(page.getByText("뺀 멤버", { exact: true }).locator("..")).toContainText("영희");
    await create(page).click();
    await expect(page).toHaveURL(`/c/${ID}`);

    const body = posts[0];
    expect(JSON.stringify(body)).not.toContain("영희");
    expect(body.members).not.toContain("영희");
    expect(Object.keys((body.stats as { byPerson: Record<string, unknown> }).byPerson)).not.toContain("영희");
    expect(body.members).toEqual(["민지", "철수", "민지, 수아"]);
  });

  test("민지만 남기면 이름 단계 [다음]이 막히고 이유가 보인다", async ({ page }) => {
    await toNames(page, androidChat(), ["철수", "민지, 수아", "영희"]);
    await expect(next(page)).toBeDisabled();
    await expect(page.getByText("분석할 사람이 2명 이상 남아야 AI 리포트를 만들 수 있어요.")).toBeVisible();
    await page.getByRole("checkbox", { name: "철수 분석에서 빼기" }).uncheck();
    await expect(next(page)).toBeEnabled();
  });

  test("만든 리포트는 시작 화면의 '내 연재'에서 다시 열 수 있고, [지금 삭제]하면 목록에서 빠진다", async ({ page, context }) => {
    await fakeApi(context, "done");
    await fakeCreate(page);
    await toReview(page);
    await create(page).click();
    await expect(page).toHaveURL(`/c/${ID}`);

    await page.goto("/");
    const mine = page.getByRole("region", { name: "내 연재" });
    await expect(mine.getByRole("link", { name: "단톡방 연재 · 잔소리하는 친구" })).toHaveAttribute("href", `/c/${ID}`);
    await mine.getByRole("link", { name: /연재/ }).click();
    await expect(page).toHaveURL(`/c/${ID}`);
    await page.getByRole("button", { name: "지금 삭제" }).click();
    await page.getByRole("button", { name: "정말 지우기" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("region", { name: "내 연재" })).toHaveCount(0);
  });

  test("413이면 maxTokens × 0.95로 한 번만 다시 만들어 보내고, 또 413이면 오류를 보여 준다", async ({ page, context }) => {
    await fakeApi(context, "running");
    const posts = await fakeCreate(page, [413, 413, 413, 202]);
    await toReview(page, androidChat({ bodies: LONG_BODIES }));

    await create(page).click();
    await expect(page.getByRole("alert").filter({ hasText: "대화가 너무 길어서" })).toBeVisible();
    expect(posts).toHaveLength(2);
    await expect(page).toHaveURL(/\/new$/);

    // 다시 누르면 처음 페이로드부터 다시 시작한다
    await create(page).click();
    await expect(page).toHaveURL(`/c/${ID}`);
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

  test("대화 홈 카드: 읽는 중 → 메모가 오면 쓰는 중 + 가장 최근 메모 한 줄 → 다 쓰면 [리포트 읽기]로 리포트 화면에 간다", async ({ page, context }) => {
    const api = await fakeApi(context, "running", { notes: false });
    await page.goto(`/c/${ID}`);
    await expect(reportCard(page)).toContainText("AI가 대화를 읽는 중");
    await expect(reportCard(page)).toContainText("창을 닫아도 서버에서 계속 써요.");
    await expect(page.getByRole("link", { name: "리포트 읽기" })).toHaveCount(0);

    api.progress = [{ range: "10-01~10-03", note: "저녁마다 이야기했다" }];
    await expect(reportCard(page)).toContainText("쓰는 중", { timeout: 10_000 });
    await expect(reportCard(page)).toContainText("저녁마다 이야기했다");

    // 메모는 가장 최근 한 줄만 보인다
    api.progress = [...api.progress, { range: "10-04~10-05", note: "주말엔 조용했다" }];
    await expect(reportCard(page)).toContainText("주말엔 조용했다", { timeout: 10_000 });
    await expect(reportCard(page)).not.toContainText("저녁마다 이야기했다");

    api.status = "done";
    await expect(reportCard(page)).toContainText("다 썼어요", { timeout: 10_000 });
    await expect(reportCard(page)).not.toContainText("창을 닫아도");
    await reportCard(page).getByRole("link", { name: "리포트 읽기" }).click();
    await expect(page).toHaveURL(`/c/${ID}/report`);
    await expect(page.getByRole("heading", { level: 1, name: "리포트 헤드라인" })).toBeVisible();
    await expect(page.getByRole("article")).toContainText("민지의 답장은 4분 안에 왔어요");
  });

  test("탭을 닫았다 다시 열어도 /c/[id]가 진행을 이어 보여 주고, 끝나면 읽을 수 있다", async ({ page, context }) => {
    const api = await fakeApi(context, "running");
    await page.goto(`/c/${ID}`);
    await expect(reportCard(page)).toContainText("저녁마다 이야기했다");
    await page.close();

    const again = await context.newPage();
    await again.goto(`/c/${ID}`);
    await expect(reportCard(again)).toContainText("쓰는 중");
    await expect(again.getByText("전체 기간에서 6개")).toBeVisible();
    await expect(again.getByText("2026-12-24 (30일 보관)")).toBeVisible();
    await expect(again.getByText("AI 생성, 재미·참고용")).toBeVisible();

    api.status = "done";
    await expect(reportCard(again).getByRole("link", { name: "리포트 읽기" })).toBeVisible({ timeout: 10_000 });

    // [지금 삭제]는 한 번 더 묻고 지운 뒤 처음 화면으로 간다
    await expect(again.getByText("리포트와 통계가 모두 지워지고 되돌릴 수 없어요.")).toBeVisible();
    await again.getByRole("button", { name: "지금 삭제" }).click();
    expect(api.deleted).toBe(0);
    await again.getByRole("button", { name: "정말 지우기" }).click();
    await expect(again).toHaveURL(/\/$/);
    expect(api.deleted).toBe(1);
  });

  test("failed 리포트 [다시 쓰기]는 이 브라우저에 둔 페이로드로 retry를 부르고, 끝난 것을 본 뒤에는 페이로드를 지운다", async ({ page, context }) => {
    const api = await fakeApi(context, "failed");
    const posts = await fakeCreate(page);
    await toReview(page);
    await create(page).click();
    await expect(page).toHaveURL(`/c/${ID}`);
    await expect(reportCard(page)).toContainText("쓰지 못했어요");
    await expect.poll(() => hasPayload(page)).toBe(true);

    await reportCard(page).getByRole("button", { name: "다시 쓰기" }).click();
    await expect.poll(() => api.retries.length).toBe(1);
    expect(api.retries[0]).toEqual({ id: ID, payload: posts[0] });
    await expect(reportCard(page)).toContainText("쓰는 중");
    await expect(page.getByRole("button", { name: "다시 쓰기" })).toHaveCount(0);

    // 다 쓴 것을 본 뒤에는 이 브라우저에 페이로드가 없다
    api.status = "done";
    await expect(reportCard(page).getByRole("link", { name: "리포트 읽기" })).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => hasPayload(page)).toBe(false);

    // 페이로드가 없으면 또 실패해도 보내지 않고 같은 파일·같은 설정으로 다시 올리라고 안내한다
    api.status = "failed";
    await page.reload();
    await reportCard(page).getByRole("button", { name: "다시 쓰기" }).click();
    await expect(reportCard(page)).toContainText("처음 올린 그 파일을 같은 표시 이름·뺀 멤버·방 종류·말투로");
    expect(api.retries).toHaveLength(1);
  });

  test("partial은 읽을 수 있고 다시 쓸 수 있으며, 정지 중에는 [다시 쓰기] 대신 마감 안내", async ({ page, context }) => {
    const api = await fakeApi(context, "partial");
    await page.goto(`/c/${ID}`);
    await expect(reportCard(page)).toContainText("일부만 썼어요");
    await expect(reportCard(page).getByRole("link", { name: "리포트 읽기" })).toBeVisible();
    await reportCard(page).getByRole("button", { name: "다시 쓰기" }).click();
    await expect(reportCard(page)).toContainText("이 브라우저에 다시 쓰기용 사본이 없어요");
    expect(api.retries).toHaveLength(0);

    api.paused = true;
    await page.reload();
    await expect(reportCard(page)).toContainText("이번 달 AI 마감");
    await expect(page.getByRole("button", { name: "다시 쓰기" })).toHaveCount(0);
  });

  test("refused·safety는 안내만 한다", async ({ page, context }) => {
    const api = await fakeApi(context, "refused");
    await page.goto(`/c/${ID}`);
    await expect(reportCard(page)).toContainText("AI가 이 대화로는 리포트를 쓰지 않았어요");
    await expect(reportCard(page).getByRole("button")).toHaveCount(0);
    api.status = "safety";
    await page.reload();
    await expect(reportCard(page)).toContainText("리포트를 쓰지 않았어요");
    await expect(reportCard(page)).toContainText("109");
  });

  test("리포트 화면: quote의 HTML은 글자로만 보이고 dialog가 뜨지 않으며, 문단 [틀렸어요]는 없다", async ({ page, context }) => {
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    await fakeApi(context, "done", { quote: XSS });
    await page.goto(`/c/${ID}/report`);
    await expect(page.getByText(XSS)).toBeVisible();
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    await expect(page.getByText("둘의 대화 연재 · AI 생성, 재미·참고용")).toBeVisible();
    // 헤드라인 → dek → 섹션 → 근거 카톡 말풍선(표시 이름 → quote → 시각). 다음 편 예고는 없다
    const text = (await page.getByRole("article").innerText()).replace(/\s+/g, " ");
    const at = ["리포트 헤드라인", "사흘 동안의 흐름", "저녁의 리듬", "민지의 답장은 4분 안에 왔어요", XSS, "2026-10-01 20:04"].map((x) => text.indexOf(x));
    expect(at.every((x) => x >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text).not.toContain("예고");
    // 말풍선: 이름(캡션) → 본문(흰 말풍선) → 옆 아래 시각(<time>)
    const bubble = page.getByRole("figure");
    await expect(bubble.locator("figcaption")).toHaveText("민지");
    await expect(bubble.locator("blockquote.bubble")).toHaveText(XSS);
    await expect(bubble.locator("time")).toHaveAttribute("datetime", /^2026-10-01T20:04/);
    await expect(bubble).toContainText(/민지[\s\S]*2026-10-01\s*20:04/);
    await expect(page.getByRole("link", { name: "← 대화 홈" })).toHaveAttribute("href", `/c/${ID}`);

    // v2.4: 문단 피드백 모음([틀렸어요])을 뺐다
    await expect(page.getByRole("button", { name: "틀렸어요" })).toHaveCount(0);
    await expect(page.getByText("틀린 문단이 있으면 알려 주세요")).toHaveCount(0);
    expect(dialogs).toEqual([]);
  });

  test("내용이 없는 리포트 화면은 상태 카드와 [대화 홈에서 진행 보기]를 보인다", async ({ page, context }) => {
    await fakeApi(context, "running");
    await page.goto(`/c/${ID}/report`);
    await expect(page.getByText("리포트 · AI가 대화를 읽는 중").or(page.getByText("리포트 · 쓰는 중"))).toBeVisible();
    await page.getByRole("link", { name: "대화 홈에서 진행 보기" }).click();
    await expect(page).toHaveURL(`/c/${ID}`);
  });

  test("{{stat:…}}을 모두 채운다: 진행 메모·헤드라인·dek·섹션 제목, 모르는 경로뿐인 메모는 건너뛰고 빈 헤드라인은 '둘의 대화 연재'", async ({
    page,
    context,
  }) => {
    const api = await fakeApi(context, "running", {
      statText: true,
      notes: [
        { range: "10-01~10-03", note: "{{stat:total}}개를 읽었다" },
        { range: "10-04~10-05", note: "{{stat:nope}}" },
      ],
    });
    const bodyText = () => page.locator("body").innerText();

    await page.goto(`/c/${ID}`);
    await expect(reportCard(page)).toContainText("6개를 읽었다");
    expect(await bodyText()).not.toContain("{{");

    api.status = "done";
    await page.goto(`/c/${ID}/report`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("민지의 4분 법칙");
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(/6번의 저녁$/);
    await expect(page.getByRole("article")).toContainText("3일 동안의 흐름");
    expect(await bodyText()).not.toMatch(/\{\{|stat:/);

    const empty = await fakeApi(context, "done", { emptyHeadline: true });
    expect(empty.status).toBe("done");
    await page.goto(`/c/${ID}/report`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("둘의 대화 연재");
    expect(await bodyText()).not.toMatch(/\{\{|stat:/);
  });

  test("v2.8 리포트 화면: 폴라로이드 아래 하이라이트 카드(케미 온도 → 통계), 사람 섹션 제목 아래 MBTI 칩과 이유. 예전 리포트는 통계 카드만", async ({
    page,
    context,
  }) => {
    await fakeApi(context, "done", { v28: true });
    await page.goto(`/c/${ID}/report`);
    const highlights = page.getByRole("region", { name: "한 줄 하이라이트" });
    // 이름표(dt) 앞의 이모지는 장식이라 글자 끝만 본다
    await expect(highlights.locator("dt")).toHaveText([/케미 온도$/, /최장 연속 대화$/, /하루 평균$/]);
    await expect(highlights.locator("dd").first()).toHaveText("78°");
    // 케미 온도 한 줄의 {{stat:…}}도 채운다
    await expect(highlights).toContainText("사흘 내내 저녁 8시에 모인 둘, 6개면 합격이다");
    await expect(highlights).toContainText("3일");
    // 하이라이트는 #report-capture 안, 폴라로이드 다음·섹션 앞이다
    await expect(page.locator("#report-capture").getByRole("region", { name: "한 줄 하이라이트" })).toBeVisible();
    const person = page.locator("section").filter({ has: page.getByRole("heading", { name: "민지, 4분 만에 답하는 사람" }) });
    await expect(person.getByRole("list", { name: "민지의 유형" }).getByRole("listitem")).toHaveText(["MBTI INFJ"]);
    await expect(person).toContainText("답은 늦지 않게, 말은 아껴서. 속으로 다 계산하는 타입이다.");
    // 메시지가 적어(20개 미만) ㅋ 유형은 없다. pair 섹션에는 칩이 없다
    await expect(page.getByText(/^ㅋ /)).toHaveCount(0);
    await expect(page.getByRole("list", { name: /의 유형$/ })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 2 })).toHaveCount(2);
    await expect(page.locator(".tape")).toHaveCount(1);

    await fakeApi(context, "done");
    await page.goto(`/c/${ID}/report`);
    await expect(page.getByRole("heading", { name: "리포트 헤드라인" })).toBeVisible();
    await expect(page.getByRole("region", { name: "한 줄 하이라이트" }).locator("dt")).toHaveText([/최장 연속 대화$/, /하루 평균$/]);
    await expect(page.getByText("케미 온도")).toHaveCount(0);
    await expect(page.getByText(/^MBTI /)).toHaveCount(0);
  });

  test("표지 칩은 말투('잔소리하는 친구')이고, 대화 홈·리포트·미리보기 공유 화면마다 테이프 1개·h1 1개이며, 옛 주소는 404", async ({ page, context }) => {
    await fakeApi(context, "done");
    for (const path of [`/c/${ID}`, `/c/${ID}/report`]) {
      await page.goto(path);
      await expect(page.getByText("잔소리하는 친구", { exact: true })).toBeVisible();
      await expect(page.locator(".tape")).toHaveCount(1);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    }
    await page.goto("/dev/preview/share");
    await expect(page.getByText("잔소리하는 친구", { exact: true })).toBeVisible();
    await expect(page.locator(".tape")).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);

    for (const path of [`/c/${ID}/steps`, `/c/${ID}/e/1`]) {
      expect((await page.goto(path))!.status()).toBe(404);
    }
  });

  test.describe("공유", () => {
    const panel = (page: Page) => page.getByRole("region", { name: "공유", exact: true });
    const NOTICE =
      "링크를 받은 사람은 초대 코드 없이 읽을 수 있어요. 표시 이름과 인용된 대화 원문이 함께 보여요. 대화와 함께 2026-12-24에 사라져요";

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

    test("리포트가 다 써져야 보이고, [링크 만들기]는 링크를 복사하며, 새로 열어도 이 기기의 링크가 남고, [링크 폐기]는 한 번 더 묻고 DELETE를 보낸다", async ({
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

      const api = await fakeApi(context, "running");
      await page.goto(`/c/${ID}`);
      await expect(reportCard(page)).toContainText("쓰는 중");
      await expect(panel(page)).toHaveCount(0);

      api.status = "done";
      await expect(panel(page)).toContainText(NOTICE, { timeout: 10_000 });
      // 범위·숨김 선택은 없다
      await expect(panel(page).getByRole("radio")).toHaveCount(0);
      await expect(panel(page).getByRole("checkbox")).toHaveCount(0);

      await panel(page).getByRole("button", { name: "링크 만들기" }).click();
      await expect(panel(page).getByText("링크를 복사했어요")).toBeVisible();
      expect(api.sharePosts).toEqual([{ id: ID }]);
      expect(await copied()).toBe(SHARE_URL);

      // 다시 열어도 이 브라우저가 기억한 링크로 [링크 복사]를 쓸 수 있다
      await page.reload();
      await expect(panel(page)).toContainText(SHARE_URL);
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

    test("예전 말투(record) 리포트는 합친 이름 '담임 선생님'으로 표지 칩과 공유 제목에 보인다", async ({ page, context }) => {
      await withNativeShare(page);
      await fakeApi(context, "done", { tone: "record" });
      await page.goto(`/c/${ID}`);
      await expect(page.getByText("담임 선생님", { exact: true })).toBeVisible();
      await expect(page.getByText("담임의 생활기록부")).toHaveCount(0);
      await panel(page).getByRole("button", { name: "링크 만들기" }).click();
      await expect(panel(page).getByText("공유했어요")).toBeVisible();
      const shared = await page.evaluate(() => (window as unknown as { __shared?: ShareData[] }).__shared);
      expect(shared).toEqual([{ title: "둘의 대화 연재 · 담임 선생님", url: SHARE_URL }]);
    });

    test("navigator.share가 있으면 [링크 만들기]가 '연재 제목 · 말투'(이름 없음)로 공유하고 [카톡으로 보내기]로 다시 보낸다", async ({ page, context }) => {
      await withNativeShare(page);
      const api = await fakeApi(context, "done");
      await page.goto(`/c/${ID}`);

      await panel(page).getByRole("button", { name: "링크 만들기" }).click();
      await expect(panel(page).getByText("공유했어요")).toBeVisible();
      const shared = await page.evaluate(() => (window as unknown as { __shared?: ShareData[] }).__shared);
      expect(shared).toEqual([{ title: "둘의 대화 연재 · 잔소리하는 친구", url: SHARE_URL }]);
      expect(api.sharePosts).toEqual([{ id: ID }]);

      await expect(panel(page).getByRole("button", { name: "저장" })).toHaveCount(0);
      await panel(page).getByRole("button", { name: "카톡으로 보내기" }).click();
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { __shared?: ShareData[] }).__shared?.length))
        .toBe(2);
    });

    test("다른 기기에서 만든 링크면 안내만 하고, 링크 만들기가 409면 대화를 다시 읽고 다시 시도하라고 한다", async ({ page, context }) => {
      await withoutNativeShare(page);
      const api = await fakeApi(context, "done", { shared: true });
      await page.goto(`/c/${ID}`);
      await expect(panel(page)).toContainText("이 기기에서 만든 링크가 아니에요. 새 링크가 필요하면 폐기 후 다시 만드세요");
      await expect(panel(page).getByRole("button", { name: "링크 복사" })).toHaveCount(0);

      // 다른 곳에서 폐기됐다가 다시 만들어지는 사이에 눌렀다
      await panel(page).getByRole("button", { name: "링크 폐기" }).click();
      await panel(page).getByRole("button", { name: "정말 폐기" }).click();
      await expect(panel(page).getByRole("button", { name: "링크 만들기" })).toBeVisible();
      api.shareReply = 409;
      await panel(page).getByRole("button", { name: "링크 만들기" }).click();
      await expect(panel(page).getByText("다른 곳에서 바뀌었어요. 다시 시도해 주세요")).toBeVisible();
      expect(api.sharePosts).toEqual([{ id: ID }]);
    });
  });

  test.describe("375px", () => {
    test.use({ viewport: { width: 375, height: 812 } });

    // keep-all이라 띄어 쓰지 않은 긴 글(ㅋ 줄, 붙여 쓴 문장)은 끊을 곳이 없는 한 단어다. 카드 밖으로 잘리지 않고 줄이 바뀌어야 한다
    test("대화 홈(쓰는 중 + 긴 ㅋ 메모)·대화 홈(다 씀)·리포트에 가로 스크롤이 없고, 띄어 쓰지 않은 긴 글도 잘리지 않는다", async ({ page, context }) => {
      const api = await fakeApi(context, "running", {
        quote: `${"ㅋ".repeat(40)}\n${"긴인용문".repeat(40)} ${XSS}`,
        paragraph: `웃음은 이렇게 이어졌어요 ${"ㅋ".repeat(30)} 그리고${"아진짜너무웃기다그거어디서봤어".repeat(3)}`,
        notes: [{ range: "10-01~10-03", note: `${"ㅋ".repeat(60)}${"아진짜너무웃기다".repeat(6)}` }],
      });
      await page.goto(`/c/${ID}`);
      await expect(reportCard(page)).toContainText("쓰는 중");
      await expectNoHorizontalScroll(page);

      api.status = "done";
      await page.goto(`/c/${ID}`);
      await expect(reportCard(page).getByRole("link", { name: "리포트 읽기" })).toBeVisible();
      await expectNoHorizontalScroll(page);
      await page.goto(`/c/${ID}/report`);
      await expect(page.getByRole("heading", { name: "리포트 헤드라인" })).toBeVisible();
      await expectNoHorizontalScroll(page);
    });

    test("긴 리포트(섹션 10 × 문단 5, 인용 30): 섹션이 모두 보이고, 인용은 그 인용을 처음 쓴 문단 바로 아래에 있으며, 가로 스크롤이 없다", async ({ page, context }) => {
      await fakeApi(context, "done", { long: true });
      await page.goto(`/c/${ID}/report`);
      await expect(page.getByRole("heading", { name: "또 저녁 8시에 모인 두 사람에게 하는 잔소리" })).toBeVisible();
      await expect(page.getByRole("heading", { level: 2, name: /^긴 잔소리 \d+$/ })).toHaveCount(10);
      await expect(page.getByRole("figure")).toHaveCount(30);
      // 섹션 하나 안의 읽는 순서: 문단 1 → 인용 1 → 문단 2 → 문단 3 → 인용 2 → 문단 4 → 문단 5 → 인용 3
      const card = page.locator("section").filter({ has: page.getByRole("heading", { name: "긴 잔소리 4", exact: true }) });
      const text = (await card.innerText()).replace(/\s+/g, " ");
      const order = ["문단 1.", "섹션 4 인용 1", "문단 2.", "문단 3.", "섹션 4 인용 2", "문단 4.", "문단 5.", "섹션 4 인용 3"].map((x) => text.indexOf(x));
      expect(order.every((i) => i >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      // 세 부분 머리말(종합 → 멤버별 → 마무리). v2.5 합친 순서라 사람 카드(섹션 8·9)가 멤버별 묶음 안에 있다
      const groups = page.getByRole("group");
      await expect(groups).toHaveCount(3);
      for (const [i, name] of ["종합", "멤버별", "마무리"].entries()) await expect(groups.nth(i)).toHaveAccessibleName(name);
      await expect(page.getByRole("group", { name: "종합" }).getByRole("heading", { level: 2 })).toHaveCount(7);
      await expect(page.getByRole("group", { name: "멤버별" }).getByRole("heading", { level: 2 })).toHaveText([/긴 잔소리 8$/, /긴 잔소리 9$/]);
      await expect(page.getByRole("group", { name: "마무리" }).getByRole("heading", { level: 2 })).toHaveText([/긴 잔소리 10$/]);
      // 검증 기록(checks: 호출 결과·뺀 섹션 수)은 화면에 보이지 않는다
      for (const hidden of ["off_stage", "unquoted", "people_rest", "intro"]) await expect(page.locator("main")).not.toContainText(hidden);
      await expectNoHorizontalScroll(page);
    });

    test("미리보기 공유 화면에 가로 스크롤이 없다", async ({ page }) => {
      await page.goto("/dev/preview/share");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoHorizontalScroll(page);
    });

    test("공유 중이라 긴 링크가 보여도 대화 홈에 가로 스크롤이 없다", async ({ page, context }) => {
      const long = `https://${"long-subdomain-".repeat(4)}analytalk.example.com/s/AAAAAAAAAAAAAAAAAAAAAA`;
      await page.addInitScript(([id, url]) => localStorage.setItem(`analytalk:share:${id}`, url), [ID, long]);
      await fakeApi(context, "done", { shared: true });
      await page.goto(`/c/${ID}`);
      await expect(page.getByRole("region", { name: "공유", exact: true })).toContainText(long);
      await expectNoHorizontalScroll(page);
    });
  });
});
