"use client";

// 대화 홈의 [공유] 영역: 범위(1편만·4편 전체)와 편별 숨김을 고르고, 링크를 만들어 카톡으로 보내거나 복사한다. 링크는 바로 폐기할 수 있다.
// 링크 원문은 처음 만든 응답에만 와서 이 브라우저에 둔다(lib/client/share). 다른 기기에서 만든 링크는 다시 보여 주지 못한다.
// 공유 제목에는 이름을 넣지 않고 컨셉 제목만 쓴다.
import { useRef, useState } from "react";
import { Highlight } from "@/components/scrap/Highlight";
import { Paper } from "@/components/scrap/Paper";
import { tapeAt } from "@/components/scrap/tilt";
import { Button } from "@/components/ui/button";
import {
  copyLink,
  createShare,
  forgetShareUrl,
  recallShareUrl,
  rememberShareUrl,
  revokeShare,
  type ShareScope,
  shareOrCopy,
} from "@/lib/client/share";
import { SUBMIT_TEXT } from "@/lib/client/submit";
import { CONCEPTS } from "@/lib/llm/concepts";
import { type ConversationView, kstDay } from "./model";

const SCOPE_LABEL: Record<ShareScope, string> = { first: "1편만", all: "4편 전체" };

const SHARE_TEXT = {
  notice: (expiresAt: string) =>
    `링크를 받은 사람은 초대 코드 없이 읽을 수 있어요. 인용된 대화 원문이 함께 보여요. 대화와 함께 ${kstDay(expiresAt)}에 사라져요`,
  otherDevice: "이 기기에서 만든 링크가 아니에요. 새 링크가 필요하면 폐기 후 다시 만드세요",
  revokeWarning: "폐기하면 이전 링크는 바로 열리지 않아요(404). 다시 공유하려면 새 링크를 만들어야 해요.",
  revoked: "링크를 폐기했어요. 이전 링크는 이제 열리지 않아요.",
  saved: "저장했어요. 링크는 그대로예요.",
  conflict: "다른 곳에서 바뀌었어요. 다시 시도해 주세요",
  generic: "처리하지 못했어요. 잠시 뒤 다시 시도해 주세요.",
  shared: "공유했어요.",
  copied: "링크를 복사했어요. 카톡 대화방에 붙여 넣어 주세요.",
  // 링크를 만든 요청을 기다리는 사이 사용자 활성화가 끊기면(Safari 등) 자동 복사가 막힌다. 버튼을 다시 누르면 된다
  copyFailed: "복사하지 못했어요. [링크 복사]를 다시 누르거나 위 주소를 길게 눌러 복사해 주세요.",
} as const;

type Notice = { text: string; error: boolean } | null;

const RESULT_NOTICE: Record<"shared" | "copied" | "cancelled" | "failed", Notice> = {
  shared: { text: SHARE_TEXT.shared, error: false },
  copied: { text: SHARE_TEXT.copied, error: false },
  cancelled: null,
  failed: { text: SHARE_TEXT.copyFailed, error: true },
};

const sameNumbers = (a: number[], b: number[]) => a.length === b.length && a.every((n, i) => n === b[i]);

export function SharePanel({ id, conversation: c, onChanged }: { id: string; conversation: ConversationView; onChanged: () => Promise<void> }) {
  /** 내용이 있는 편(done·partial)만 공유·숨김 대상이다 */
  const readable = c.episodes.filter((e) => e.status === "done" || e.status === "partial").map((e) => e.n);
  const savedScope = c.shareScope ?? "first";
  const savedHidden = [...c.shareHidden].sort((a, b) => a - b);

  const [scope, setScope] = useState<ShareScope>(savedScope);
  const [hidden, setHidden] = useState<number[]>(savedHidden);
  // 이 영역은 대화를 불러온 뒤 브라우저에서만 그려진다(서버 렌더 때는 PageState)
  const [url, setUrl] = useState<string | null>(() => recallShareUrl(id));
  const [canShare] = useState(() => typeof navigator !== "undefined" && typeof navigator.share === "function");
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  /** 다시 그리기 전의 두 번째 탭도 막는다(동시 요청은 409가 된다) */
  const inFlight = useRef(false);

  if (readable.length === 0) return null;

  const title = CONCEPTS[c.concept].title;
  const link = c.shared ? url : null;
  const dirty = scope !== savedScope || !sameNumbers(hidden, savedHidden);

  async function run(task: () => Promise<Notice>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNotice(null);
    try {
      setNotice(await task());
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  /** 실패 응답: 409·404면 대화를 다시 읽는다(404면 대화 홈이 '찾을 수 없음'으로 바뀐다) */
  async function failure(status: number): Promise<Notice> {
    if (status === 409 || status === 404) await onChanged();
    if (status === 409) return { text: SHARE_TEXT.conflict, error: true };
    if (status === 401) return { text: SUBMIT_TEXT.session, error: true };
    return { text: SHARE_TEXT.generic, error: true };
  }

  /** [링크 만들기]·[저장]. 새 링크가 나오면 기억하고 바로 보내기·복사로 간다 */
  async function submit(): Promise<Notice> {
    const r = await createShare(id, scope, hidden);
    if (!r.ok) return failure(r.status);
    let next: Notice;
    if (r.url) {
      rememberShareUrl(id, r.url);
      setUrl(r.url);
      next = RESULT_NOTICE[await shareOrCopy(r.url, title)];
    } else {
      // 이미 공유 중이라 범위만 바뀌었다. 링크는 기억해 둔 것을 그대로 쓴다(다른 탭이 먼저 만들었을 수도 있어 다시 읽는다)
      setUrl(recallShareUrl(id));
      next = c.shared ? { text: SHARE_TEXT.saved, error: false } : null;
    }
    await onChanged();
    return next;
  }

  async function revoke(): Promise<Notice> {
    const r = await revokeShare(id);
    setAsking(false);
    if (!r.ok && r.status !== 404) return failure(r.status);
    forgetShareUrl(id);
    setUrl(null);
    await onChanged();
    return r.ok ? { text: SHARE_TEXT.revoked, error: false } : null;
  }

  const send = async () => (link ? RESULT_NOTICE[await shareOrCopy(link, title)] : null);
  const copy = async () => (link ? RESULT_NOTICE[await copyLink(link)] : null);

  function toggleHidden(n: number, on: boolean) {
    setHidden((prev) => (on ? [...new Set([...prev, n])] : prev.filter((x) => x !== n)).sort((a, b) => a - b));
  }

  return (
    <Paper as="section" aria-labelledby="share-title" tilt="right" calm tape={tapeAt(4)} className="grid gap-3 pt-6">
      <h2 id="share-title" className="font-hand text-[1.75rem] leading-tight font-bold">
        <Highlight color="mint">공유</Highlight>
      </h2>
      <p className="text-base text-muted-foreground">{SHARE_TEXT.notice(c.expiresAt)}</p>

      <fieldset disabled={busy} className="grid gap-2">
        <legend className="mb-1 text-base font-bold">공유 범위</legend>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(SCOPE_LABEL) as ShareScope[]).map((s) => (
            <label key={s} className="flex min-h-11 items-center gap-2 rounded-lg border bg-sheet px-3.5 py-2 text-base has-checked:border-foreground">
              <input type="radio" name="share-scope" value={s} checked={scope === s} onChange={() => setScope(s)} />
              {SCOPE_LABEL[s]}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset disabled={busy} className="grid gap-2">
        <legend className="mb-1 text-base font-bold">숨길 편</legend>
        <div className="flex flex-wrap gap-x-5">
          {readable.map((n) => (
            <label key={n} className="flex items-center gap-2 py-2.5 text-base">
              <input type="checkbox" checked={hidden.includes(n)} onChange={(e) => toggleHidden(n, e.target.checked)} />
              {n}편 숨기기
            </label>
          ))}
        </div>
      </fieldset>

      {!c.shared ? (
        <Button className="justify-self-start" disabled={busy} onClick={() => run(submit)}>
          링크 만들기
        </Button>
      ) : (
        <div className="grid gap-3">
          {link ? (
            <div className="grid gap-2">
              <p className="rounded-lg bg-muted px-3 py-2 font-mono text-sm break-all select-all">{link}</p>
              <div className="flex flex-wrap gap-2">
                {canShare && (
                  <Button disabled={busy} onClick={() => run(send)}>
                    카톡으로 보내기
                  </Button>
                )}
                <Button variant="outline" disabled={busy} onClick={() => run(copy)}>
                  링크 복사
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-base">{SHARE_TEXT.otherDevice}</p>
          )}

          {asking ? (
            <div className="grid gap-2">
              <p className="text-base">{SHARE_TEXT.revokeWarning}</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="destructive" disabled={busy} onClick={() => run(revoke)}>
                  정말 폐기
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => setAsking(false)}>
                  취소
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {dirty && (
                <Button disabled={busy} onClick={() => run(submit)}>
                  저장
                </Button>
              )}
              <Button variant="destructive" disabled={busy} onClick={() => setAsking(true)}>
                링크 폐기
              </Button>
            </div>
          )}
        </div>
      )}

      {notice && (
        <p role={notice.error ? "alert" : "status"} className={notice.error ? "text-base text-destructive" : "text-base text-muted-foreground"}>
          {notice.text}
        </p>
      )}
    </Paper>
  );
}
