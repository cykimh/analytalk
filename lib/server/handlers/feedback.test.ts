import { afterEach, describe, expect, it, vi } from "vitest";
import { harness, makePayload, request } from "@/test/generation";
import { handleCreateConversation } from "./conversations";
import { handleFeedback } from "./feedback";

afterEach(() => vi.restoreAllMocks());

const feedback = (cookie: string | null, body: unknown) => request("POST", "/api/feedback", cookie, body);

/** 리포트가 done인 대화(섹션 2개, 문단 키는 둘 다 p1) */
async function created() {
  const h = await harness();
  const res = await handleCreateConversation(request("POST", "/api/conversations", h.cookie, makePayload()), h.deps);
  await h.settle();
  return { h, id: (res.body as { id: string }).id };
}

describe("POST /api/feedback", () => {
  it("문단 [틀렸어요]: 리포트에 있는 문단이면 204로 남긴다(문단 키는 섹션 번호를 붙인 s<섹션>.<키>). 편 번호는 없다", async () => {
    const { h, id } = await created();
    const add = vi.spyOn(h.repo, "addFeedback");
    const res = await handleFeedback(feedback(h.cookie, { id, paragraphKey: "s2.p1", reason: "wrong_fact" }), h.deps);
    expect(res).toEqual({ status: 204, body: undefined });
    expect(add.mock.calls).toEqual([[{ id, paragraphKey: "s2.p1", reason: "wrong_fact" }]]);
  });

  it("옛 본문 {id, n, paragraphKey, reason}도 받는다(n은 버린다)", async () => {
    const { h, id } = await created();
    const add = vi.spyOn(h.repo, "addFeedback");
    expect((await handleFeedback(feedback(h.cookie, { id, n: 2, paragraphKey: "s1.p1", reason: "tone" }), h.deps)).status).toBe(204);
    expect(add.mock.calls).toEqual([[{ id, paragraphKey: "s1.p1", reason: "tone" }]]);
  });

  it("리포트에 없는 문단 키·없는 섹션은 404로 남기지 않는다", async () => {
    const { h, id } = await created();
    const add = vi.spyOn(h.repo, "addFeedback");
    for (const paragraphKey of ["s3.p1", "s1.p2", "p1", "s0.p1"]) {
      expect((await handleFeedback(feedback(h.cookie, { id, paragraphKey, reason: "tone" }), h.deps)).status).toBe(404);
    }
    expect(add).not.toHaveBeenCalled();
  });

  it("내용이 없는 리포트(아직 쓰는 중)는 404", async () => {
    const h = await harness();
    h.state.manual = true;
    const res = await handleCreateConversation(request("POST", "/api/conversations", h.cookie, makePayload()), h.deps);
    const { id } = res.body as { id: string };
    const out = await handleFeedback(feedback(h.cookie, { id, paragraphKey: "s1.p1", reason: "tone" }), h.deps);
    expect(out).toEqual({ status: 404, body: { error: "not_found" } });
  });

  it("다른 invite·없는 대화는 404, 쿠키가 없으면 401", async () => {
    const { h, id } = await created();
    const add = vi.spyOn(h.repo, "addFeedback");
    const body = { id, paragraphKey: "s1.p1", reason: "other" };
    expect((await handleFeedback(feedback(h.otherCookie, body), h.deps)).status).toBe(404);
    expect((await handleFeedback(feedback(h.cookie, { ...body, id: "0b6c3f1e-2a4d-4c5b-9e8f-7a6b5c4d3e2f" }), h.deps)).status).toBe(404);
    expect((await handleFeedback(feedback(null, body), h.deps)).status).toBe(401);
    expect(add).not.toHaveBeenCalled();
  });

  it("본문이 틀리면 400: 모르는 이유·빈 키·너무 긴 키·id 없음·JSON 아님", async () => {
    const { h, id } = await created();
    const ok = { id, paragraphKey: "s1.p1", reason: "tone" };
    for (const body of [
      { ...ok, reason: "boring" },
      { ...ok, paragraphKey: "" },
      { ...ok, paragraphKey: "s1.".padEnd(200, "p") },
      { ...ok, id: undefined },
    ]) {
      expect((await handleFeedback(feedback(h.cookie, body), h.deps)).status).toBe(400);
    }
    const notJson = new Request("https://analytalk.example.com/api/feedback", {
      method: "POST",
      headers: { cookie: h.cookie, "content-type": "application/json" },
      body: "{",
    });
    expect((await handleFeedback(notJson, h.deps)).status).toBe(400);
  });
});
