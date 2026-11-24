// 소유자 공유 화면(components/episode/SharePanel)이 부르는 것: 공유 API(POST·DELETE /api/shares), 카톡 보내기·링크 복사, 발급한 링크 보관.
// 원문 토큰은 DB에 없고 링크를 처음 만든 응답에만 한 번 온다. 그래서 받은 URL은 이 브라우저의 localStorage에 대화별로 둔다.

export type ShareScope = "first" | "all";

/** 네트워크 오류는 status 0 */
type Failed = { ok: false; status: number };
/** 테스트는 fetch를 주입한다 */
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

const sendJson = (fetcher: Fetcher, method: "POST" | "DELETE", body: unknown) =>
  fetcher("/api/shares", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** 공유 범위·숨김을 정한다. 처음 만들면 url, 이미 공유 중이면(범위만 바뀜) url은 null이다(409: 다른 곳에서 동시에 바뀜) */
export async function createShare(
  id: string,
  scope: ShareScope,
  hidden: number[],
  fetcher: Fetcher = fetch,
): Promise<{ ok: true; url: string | null } | Failed> {
  let res: Response;
  try {
    res = await sendJson(fetcher, "POST", { id, scope, hidden });
  } catch {
    return { ok: false, status: 0 };
  }
  if (!res.ok) return { ok: false, status: res.status };
  const body: unknown = await res.json().catch(() => null);
  const url = typeof body === "object" && body !== null ? (body as { url?: unknown }).url : null;
  return { ok: true, url: typeof url === "string" ? url : null };
}

/** 링크를 폐기한다(204). 이전 링크는 바로 404가 된다 */
export async function revokeShare(id: string, fetcher: Fetcher = fetch): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await sendJson(fetcher, "DELETE", { id });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

/** 공유·복사에 쓰는 navigator 부분(테스트는 주입한다) */
export interface ShareNavigator {
  share?: (data: ShareData) => Promise<void>;
  clipboard?: { writeText(text: string): Promise<void> };
}

const browserNavigator = (): ShareNavigator | undefined => (typeof navigator === "undefined" ? undefined : navigator);

const isAbort = (e: unknown) => typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError";

/** 클립보드에 url을 복사한다 */
export async function copyLink(url: string, nav: ShareNavigator | undefined = browserNavigator()): Promise<"copied" | "failed"> {
  try {
    if (!nav?.clipboard) return "failed";
    await nav.clipboard.writeText(url);
    return "copied";
  } catch {
    return "failed";
  }
}

/** navigator.share가 있으면 그것을 쓴다. 사용자가 취소(AbortError)하면 "cancelled"로 끝나고 복사하지 않는다. share가 없거나 다른 이유로 실패하면 클립보드 복사를 쓴다 */
export async function shareOrCopy(
  url: string,
  title: string,
  nav: ShareNavigator | undefined = browserNavigator(),
): Promise<"shared" | "copied" | "cancelled" | "failed"> {
  if (typeof nav?.share === "function") {
    try {
      await nav.share({ title, url });
      return "shared";
    } catch (e) {
      if (isAbort(e)) return "cancelled";
      // 사용자 활성화가 끊겼거나(NotAllowedError) 공유를 못 하는 환경이면 복사로 넘어간다
    }
  }
  return copyLink(url, nav);
}

const storageKey = (id: string) => `analytalk:share:${id}`;

/** 발급한 URL은 서버에 원문이 없으므로 이 브라우저의 localStorage에 대화별로 둔다(키 `analytalk:share:<id>`). try/catch로 감싸고, 저장이 안 돼도 화면은 동작한다 */
export function rememberShareUrl(id: string, url: string): void {
  try {
    localStorage.setItem(storageKey(id), url);
  } catch {
    // 사생활 보호 모드·저장 차단: 이 기기에서 다시 보여 주지 못할 뿐이다
  }
}

export function recallShareUrl(id: string): string | null {
  try {
    return localStorage.getItem(storageKey(id));
  } catch {
    return null;
  }
}

export function forgetShareUrl(id: string): void {
  try {
    localStorage.removeItem(storageKey(id));
  } catch {
    // 위와 같다
  }
}
