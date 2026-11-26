import { expect, test } from "@playwright/test";
import { login } from "./helpers";

// 테스트 모드 서버에는 Claude가 없어 대화를 만들 수 없다(내용이 든 공유 화면과 폐기 반영은 shares.test.ts가 저장소까지 시험한다).
// 여기서는 대화 없이 확인할 수 있는 공개 경계를 본다: 모르는 토큰, 응답 헤더, 고정 OG 이미지, 공유 API의 인증.

const UNKNOWN_TOKEN = "AAAAAAAAAAAAAAAAAAAAAA";
const ID = "0b6c3f1e-2a4d-4c5b-9e8f-7a6b5c4d3e2f";

test("모르는 토큰은 초대 코드 없이도 404이고, noindex·no-referrer 헤더가 붙는다", async ({ page }) => {
  const res = await page.goto(`/s/${UNKNOWN_TOKEN}`);
  expect(res!.status()).toBe(404);
  expect(res!.headers()["x-robots-tag"]).toBe("noindex");
  expect(res!.headers()["referrer-policy"]).toBe("no-referrer");
  expect(res!.headers()["cache-control"] ?? "").not.toMatch(/s-maxage|public/);
});

test("모양이 틀린 토큰도 404", async ({ page }) => {
  const res = await page.goto("/s/short");
  expect(res!.status()).toBe(404);
});

test("컨셉별 고정 OG 이미지가 있다", async ({ request }) => {
  for (const concept of ["group", "couple"]) {
    const res = await request.get(`/og/${concept}.png`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/png");
  }
});

test("공유 API는 세션이 없으면 401, 없는 대화는 404", async ({ page, request }) => {
  expect((await request.post("/api/shares", { data: { id: ID } })).status()).toBe(401);
  expect((await request.delete("/api/shares", { data: { id: ID } })).status()).toBe(401);
  await login(page);
  expect((await page.request.post("/api/shares", { data: { id: ID } })).status()).toBe(404);
  expect((await page.request.delete("/api/shares", { data: { id: ID } })).status()).toBe(404);
});
