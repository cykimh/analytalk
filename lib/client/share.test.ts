import { afterEach, describe, expect, it, vi } from "vitest";
import { copyLink, createShare, forgetShareUrl, recallShareUrl, rememberShareUrl, revokeShare, shareOrCopy } from "./share";

const ID = "0b6c3f1e-2a4d-4c5b-9e8f-7a6b5c4d3e2f";
const URL_ = "https://analytalk.example.com/s/AAAAAAAAAAAAAAAAAAAAAA";

/** 응답 하나를 돌려주고 받은 요청을 기록하는 fetch */
function fakeFetch(reply: Response | Error) {
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    if (reply instanceof Error) throw reply;
    return reply;
  });
}
const sent = (f: ReturnType<typeof fakeFetch>) => {
  const [url, init] = f.mock.calls[0];
  return { url, method: init?.method, type: new Headers(init?.headers).get("content-type"), body: JSON.parse(String(init?.body)) };
};

describe("createShare", () => {
  it("POST /api/shares에 {id}를 JSON으로 보내고, 새 링크면 url을 돌려준다", async () => {
    const f = fakeFetch(Response.json({ url: URL_, shared: true }));
    expect(await createShare(ID, f)).toEqual({ ok: true, url: URL_ });
    expect(sent(f)).toEqual({
      url: "/api/shares",
      method: "POST",
      type: "application/json",
      body: { id: ID },
    });
  });

  it("이미 공유 중이면url은 null", async () => {
    const f = fakeFetch(Response.json({ url: null, shared: true }));
    expect(await createShare(ID, f)).toEqual({ ok: true, url: null });
  });

  it.each([409, 404, 401, 400])("%i면 상태를 돌려준다", async (status) => {
    const f = fakeFetch(Response.json({ error: "x" }, { status }));
    expect(await createShare(ID, f)).toEqual({ ok: false, status });
  });

  it("네트워크 오류는 status 0", async () => {
    expect(await createShare(ID, fakeFetch(new TypeError("offline")))).toEqual({ ok: false, status: 0 });
  });
});

describe("revokeShare", () => {
  it("DELETE /api/shares에 {id}를 보내고 204면 ok", async () => {
    const f = fakeFetch(new Response(null, { status: 204 }));
    expect(await revokeShare(ID, f)).toEqual({ ok: true, status: 204 });
    expect(sent(f)).toEqual({ url: "/api/shares", method: "DELETE", type: "application/json", body: { id: ID } });
  });

  it("404·401은 ok가 아니고, 네트워크 오류는 status 0", async () => {
    expect(await revokeShare(ID, fakeFetch(Response.json({ error: "not_found" }, { status: 404 })))).toEqual({ ok: false, status: 404 });
    expect(await revokeShare(ID, fakeFetch(Response.json({ error: "unauthorized" }, { status: 401 })))).toEqual({ ok: false, status: 401 });
    expect(await revokeShare(ID, fakeFetch(new TypeError("offline")))).toEqual({ ok: false, status: 0 });
  });
});

describe("shareOrCopy", () => {
  const clipboard = () => ({ writeText: vi.fn(async (_text: string) => {}) });

  it("navigator.share가 있으면 제목·url로 공유하고 복사하지 않는다", async () => {
    const nav = { share: vi.fn(async (_data: ShareData) => {}), clipboard: clipboard() };
    expect(await shareOrCopy(URL_, "연애·썸", nav)).toBe("shared");
    expect(nav.share).toHaveBeenCalledExactlyOnceWith({ title: "연애·썸", url: URL_ });
    expect(nav.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("share가 없으면 클립보드에 url을 복사한다", async () => {
    const nav = { clipboard: clipboard() };
    expect(await shareOrCopy(URL_, "연애·썸", nav)).toBe("copied");
    expect(nav.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(URL_);
  });

  it("사용자가 공유를 취소하면(AbortError) cancelled이고 복사하지 않는다", async () => {
    const nav = {
      share: vi.fn(async (_data: ShareData) => {
        throw new DOMException("Share canceled", "AbortError");
      }),
      clipboard: clipboard(),
    };
    expect(await shareOrCopy(URL_, "연애·썸", nav)).toBe("cancelled");
    expect(nav.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("share가 다른 이유로 실패하면(NotAllowedError 등) 복사로 넘어간다", async () => {
    const nav = {
      share: vi.fn(async (_data: ShareData) => {
        throw new DOMException("no user activation", "NotAllowedError");
      }),
      clipboard: clipboard(),
    };
    expect(await shareOrCopy(URL_, "연애·썸", nav)).toBe("copied");
    expect(nav.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(URL_);
  });

  it("share도 clipboard도 없으면 failed", async () => {
    expect(await shareOrCopy(URL_, "연애·썸", {})).toBe("failed");
    expect(await shareOrCopy(URL_, "연애·썸", undefined)).toBe("failed");
  });

  it("복사가 거절되면 failed", async () => {
    const nav = { clipboard: { writeText: vi.fn(async () => Promise.reject(new DOMException("denied", "NotAllowedError"))) } };
    expect(await shareOrCopy(URL_, "연애·썸", nav)).toBe("failed");
  });

  it("copyLink는 share가 있어도 복사만 한다", async () => {
    const nav = { share: vi.fn(async (_data: ShareData) => {}), clipboard: clipboard() };
    expect(await copyLink(URL_, nav)).toBe("copied");
    expect(nav.share).not.toHaveBeenCalled();
    expect(nav.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(URL_);
  });
});

describe("remember/recall/forgetShareUrl", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const setStorage = (descriptor: PropertyDescriptor) => Object.defineProperty(globalThis, "localStorage", { configurable: true, ...descriptor });

  /** 메모리 Map으로 된 localStorage */
  function memoryStorage() {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, String(v)),
      removeItem: (k: string) => void map.delete(k),
    };
  }

  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("대화별 키 analytalk:share:<id>에 두고 다시 읽고 지운다", () => {
    const storage = memoryStorage();
    setStorage({ value: storage, writable: true });
    expect(recallShareUrl(ID)).toBeNull();
    rememberShareUrl(ID, URL_);
    rememberShareUrl("other", `${URL_}B`);
    expect([...storage.map.keys()]).toEqual([`analytalk:share:${ID}`, "analytalk:share:other"]);
    expect(recallShareUrl(ID)).toBe(URL_);
    forgetShareUrl(ID);
    expect(recallShareUrl(ID)).toBeNull();
    expect(recallShareUrl("other")).toBe(`${URL_}B`);
  });

  it("localStorage 메서드가 throw해도(용량 초과·차단) 예외가 나지 않고 recall은 null", () => {
    const boom = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    setStorage({ value: { getItem: boom, setItem: boom, removeItem: boom }, writable: true });
    expect(() => rememberShareUrl(ID, URL_)).not.toThrow();
    expect(recallShareUrl(ID)).toBeNull();
    expect(() => forgetShareUrl(ID)).not.toThrow();
  });

  it("localStorage에 접근만 해도 throw하는 브라우저(쿠키 차단)에서도 예외가 나지 않는다", () => {
    setStorage({
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    });
    expect(() => rememberShareUrl(ID, URL_)).not.toThrow();
    expect(recallShareUrl(ID)).toBeNull();
    expect(() => forgetShareUrl(ID)).not.toThrow();
  });
});
