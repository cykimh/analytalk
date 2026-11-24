import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/payload/hash";
import { BASE, harness, makePayload, request, SECRETS } from "@/test/generation";
import { signInternal } from "../jobs";
import { handleCreateConversation } from "./conversations";
import { handleInternalEpisode } from "./internal";

/** 1편 작업은 버리고 2~4편이 queued인 대화 */
async function queued() {
  const h = await harness();
  h.state.manual = true;
  const payload = makePayload();
  const res = await handleCreateConversation(request("POST", "/api/conversations", h.cookie, payload), h.deps);
  h.queued.splice(0);
  return { h, payload, id: (res.body as { id: string }).id, sha: await sha256Hex(JSON.stringify(payload)) };
}

function call(h: { deps: Parameters<typeof handleInternalEpisode>[1] }, body: unknown, signature?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== undefined) headers["x-analytalk-signature"] = signature;
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return handleInternalEpisode(new Request(`${BASE}/api/internal/episodes`, { method: "POST", headers, body: raw }), h.deps);
}

const sign = (id: string, n: number, sha: string, ts = Date.now(), secret = SECRETS.internal) =>
  signInternal({ id, n, payloadSha256: sha }, ts, secret);

describe("POST /api/internal/episodes", () => {
  it("서명이 맞으면 202, 그 편을 running으로 바꾸고 작업을 예약한다", async () => {
    const { h, payload, id, sha } = await queued();
    const res = await call(h, { id, n: 2, payload }, sign(id, 2, sha));
    expect(res.status).toBe(202);
    expect((await h.repo.getConversation(id))!.episodes[1].status).toBe("running");
    expect(h.queued).toHaveLength(1);
    h.runQueued();
    await h.settle();
    expect((await h.repo.getConversation(id))!.episodes[1].status).toBe("done");
    expect(h.streams.map((s) => s.n)).toEqual([2]);
  });

  it("서명이 없거나, 61초 지났거나, 다른 secret·다른 편으로 서명했으면 404", async () => {
    const { h, payload, id, sha } = await queued();
    const body = { id, n: 2, payload };
    expect((await call(h, body)).status).toBe(404);
    expect((await call(h, body, sign(id, 2, sha, Date.now() - 61_000))).status).toBe(404);
    expect((await call(h, body, sign(id, 2, sha, Date.now(), `${SECRETS.internal}x`))).status).toBe(404);
    expect((await call(h, body, sign(id, 3, sha))).status).toBe(404);
    // 서명한 뒤 payload를 바꿔도 404
    expect((await call(h, { ...body, payload: makePayload(1) }, sign(id, 2, sha))).status).toBe(404);
    expect((await h.repo.getConversation(id))!.episodes[1].status).toBe("queued");
    expect(h.queued).toHaveLength(0);
  });

  it("본문이 틀리면(JSON 아님·n이 2~4 밖·payload 없음) 404", async () => {
    const { h, payload, id, sha } = await queued();
    expect((await call(h, "{", sign(id, 2, sha))).status).toBe(404);
    expect((await call(h, { id, n: 1, payload }, sign(id, 1, sha))).status).toBe(404);
    expect((await call(h, { id, n: 2 }, sign(id, 2, sha))).status).toBe(404);
  });

  it("서명은 맞는데 payload 해시가 대화 행과 다르거나 대화가 없으면 409", async () => {
    const { h, id } = await queued();
    const other = makePayload(1);
    const otherSha = await sha256Hex(JSON.stringify(other));
    expect((await call(h, { id, n: 2, payload: other }, sign(id, 2, otherSha))).status).toBe(409);
    const missing = "0b6c3f1e-2a4d-4c5b-9e8f-7a6b5c4d3e2f";
    expect((await call(h, { id: missing, n: 2, payload: other }, sign(missing, 2, otherSha))).status).toBe(409);
    expect(h.queued).toHaveLength(0);
  });

  it("이미 시작한 편이면(startEpisode false) 409", async () => {
    const { h, payload, id, sha } = await queued();
    expect((await call(h, { id, n: 3, payload }, sign(id, 3, sha))).status).toBe(202);
    expect((await call(h, { id, n: 3, payload }, sign(id, 3, sha))).status).toBe(409);
    expect(h.queued).toHaveLength(1);
  });
});
