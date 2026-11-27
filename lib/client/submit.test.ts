import { describe, expect, it, vi } from "vitest";
import type { Payload } from "@/lib/payload/build";
import { createSeries, retryReport, SUBMIT_TEXT } from "./submit";

const first = { v: 1, me: "멤버1", transcript: "첫 페이로드" } as unknown as Payload;
const smaller = { v: 1, me: "멤버1", transcript: "줄인 페이로드" } as unknown as Payload;
const ID = "0b6c3f1e-2a4d-4c5b-9e8f-7a6b5c4d3e2f";

const json = (status: number, body?: unknown) =>
  body === undefined ? new Response(null, { status }) : Response.json(body, { status });

/** 차례로 응답을 돌려주는 post와 기록 */
function deps(...responses: (Response | Error)[]) {
  const sent: Payload[] = [];
  const post = vi.fn(async (p: Payload) => {
    sent.push(p);
    const r = responses.shift();
    if (!r) throw new Error("응답을 더 준비하지 않았다");
    if (r instanceof Error) throw r;
    return r;
  });
  const rebuild = vi.fn(async (_maxTokens: number) => smaller);
  const save = vi.fn(async (_id: string, _p: Payload) => {});
  return { sent, post, rebuild, save };
}

describe("createSeries ([연재 만들기])", () => {
  it.each([202, 200])("%i {id}면 그 페이로드를 저장하고 id를 돌려준다", async (status) => {
    const d = deps(json(status, { id: ID }));
    expect(await createSeries(first, d)).toEqual({ ok: true, id: ID });
    expect(d.save).toHaveBeenCalledWith(ID, first);
    expect(d.rebuild).not.toHaveBeenCalled();
  });

  it("413 {maxTokens}면 그 값으로 한 번 다시 만들어 보내고, 받아 준 페이로드를 저장한다", async () => {
    const d = deps(json(413, { maxTokens: 100_000 }), json(202, { id: ID }));
    expect(await createSeries(first, d)).toEqual({ ok: true, id: ID });
    expect(d.rebuild).toHaveBeenCalledExactlyOnceWith(100_000);
    expect(d.sent).toEqual([first, smaller]);
    expect(d.save).toHaveBeenCalledExactlyOnceWith(ID, smaller);
  });

  it("두 번째 413 문구는 다시 시도하라고 하지 않는다(같은 파일이면 결과가 같다)", () => {
    expect(SUBMIT_TEXT.tooLong).not.toContain("잠시 뒤");
    expect(SUBMIT_TEXT.cannotSend).not.toContain("잠시 뒤");
  });

  it("다시 만든 뒤에도 413이면 더 줄이지 않고 오류 문구", async () => {
    const d = deps(json(413, { maxTokens: 100_000 }), json(413, { maxTokens: 90_000 }));
    expect(await createSeries(first, d)).toEqual({ ok: false, message: SUBMIT_TEXT.tooLong });
    expect(d.rebuild).toHaveBeenCalledTimes(1);
    expect(d.post).toHaveBeenCalledTimes(2);
    expect(d.save).not.toHaveBeenCalled();
  });

  it("줄여 다시 만들지 못하면(예산이 너무 작음) 보내지 않고 같은 오류 문구", async () => {
    const d = deps(json(413, { maxTokens: 10 }));
    d.rebuild.mockRejectedValueOnce(new Error("예산이 모자라다"));
    expect(await createSeries(first, d)).toEqual({ ok: false, message: SUBMIT_TEXT.tooLong });
    expect(d.post).toHaveBeenCalledTimes(1);
  });

  it("413에 maxTokens가 없으면 다시 만들지 않는다", async () => {
    const d = deps(json(413, {}));
    expect(await createSeries(first, d)).toEqual({ ok: false, message: SUBMIT_TEXT.tooLong });
    expect(d.rebuild).not.toHaveBeenCalled();
  });

  it.each([
    [json(423, { error: "paused" }), "이번 달 AI 마감"],
    [json(429, { reason: "invite_limit" }), "이 코드의 이번 달 횟수를 다 썼어요"],
    [json(429, { reason: "daily_limit" }), "오늘 분량이 다 찼어요. 내일 다시 와 주세요"],
    [json(429, { reason: "global_limit" }), SUBMIT_TEXT.weekFull],
    [json(401, { error: "unauthorized" }), SUBMIT_TEXT.session],
    // 페이로드는 같은 파일·같은 설정이면 똑같이 만들어져 다시 올려도 같은 400이다
    [json(400, { error: "bad_payload", reason: "size" }), SUBMIT_TEXT.cannotSend],
    [json(503, { error: "not_ready" }), SUBMIT_TEXT.notReady],
    [json(502, { error: "count_tokens_failed" }), SUBMIT_TEXT.generic],
    [new TypeError("Failed to fetch"), SUBMIT_TEXT.generic],
  ])("응답별 문구 %#", async (res, message) => {
    const d = deps(res);
    expect(await createSeries(first, d)).toEqual({ ok: false, message });
    expect(d.save).not.toHaveBeenCalled();
    expect(d.rebuild).not.toHaveBeenCalled();
  });

  it("202인데 id가 없으면 실패로 본다", async () => {
    const d = deps(json(202, {}));
    expect(await createSeries(first, d)).toEqual({ ok: false, message: SUBMIT_TEXT.generic });
  });

  it("저장에 실패해도(사생활 보호 모드 등) 연재는 만들어졌으니 id를 돌려준다", async () => {
    const d = deps(json(202, { id: ID }));
    d.save.mockRejectedValueOnce(new Error("blocked"));
    expect(await createSeries(first, d)).toEqual({ ok: true, id: ID });
  });
});

describe("retryReport ([다시 쓰기])", () => {
  function retryDeps(payload: Payload | null, res?: Response | Error) {
    const sent: unknown[] = [];
    return {
      sent,
      load: vi.fn(async (_id: string) => payload),
      post: vi.fn(async (body: unknown) => {
        sent.push(body);
        if (!res) throw new Error("응답을 준비하지 않았다");
        if (res instanceof Error) throw res;
        return res;
      }),
    };
  }

  it("이 브라우저에 둔 페이로드를 {id, payload}로(n 없이) 보내고 202면 ok", async () => {
    const d = retryDeps(first, json(202));
    expect(await retryReport(ID, d)).toEqual({ ok: true });
    expect(d.load).toHaveBeenCalledWith(ID);
    expect(d.sent).toEqual([{ id: ID, payload: first }]);
  });

  it("페이로드가 없으면(24시간 지남·다른 브라우저) 보내지 않고 같은 파일·같은 설정으로 다시 올리라고 안내한다", async () => {
    const d = retryDeps(null);
    expect(await retryReport(ID, d)).toEqual({ ok: false, message: SUBMIT_TEXT.reupload });
    expect(SUBMIT_TEXT.reupload).toContain("처음 올린 그 파일");
    expect(SUBMIT_TEXT.reupload).toContain("뺀 멤버");
    expect(SUBMIT_TEXT.reupload).toContain("말투");
    expect(d.post).not.toHaveBeenCalled();
    const broken = retryDeps(first);
    broken.load.mockRejectedValueOnce(new Error("blocked"));
    expect(await retryReport(ID, broken)).toEqual({ ok: false, message: SUBMIT_TEXT.reupload });
  });

  it.each([
    [json(409, { error: "payload_mismatch" }), SUBMIT_TEXT.reupload],
    [json(400, { error: "bad_payload", reason: "lines" }), SUBMIT_TEXT.reupload],
    [json(429, { reason: "retry_limit" }), SUBMIT_TEXT.retryLimit],
    [json(429, { reason: "global_limit" }), SUBMIT_TEXT.weekFull],
    [json(409, { error: "not_startable" }), SUBMIT_TEXT.notStartable],
    [json(423, { error: "paused" }), "이번 달 AI 마감"],
    [json(401, { error: "unauthorized" }), SUBMIT_TEXT.session],
    [json(503, { error: "not_ready" }), SUBMIT_TEXT.notReady],
    [new TypeError("Failed to fetch"), SUBMIT_TEXT.generic],
  ])("응답별 문구 %#", async (res, message) => {
    expect(await retryReport(ID, retryDeps(first, res))).toEqual({ ok: false, message });
  });
});
