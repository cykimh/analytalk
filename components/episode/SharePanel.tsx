"use client";

// 대화 홈의 [공유] 영역: 링크를 만들어 카톡으로 보내거나 복사한다. 링크는 바로 폐기할 수 있다(범위·숨김 선택은 없다. 리포트가 한 편이다).
// 링크 원문은 처음 만든 응답에만 와서 이 브라우저에 둔다(lib/client/share). 다른 기기에서 만든 링크는 다시 보여 주지 못한다.
// 공유 시트 제목에는 이름을 넣지 않고 '연재 제목 · 말투'만 쓴다.
import { useRef, useState } from "react";
import { Highlight } from "@/components/scrap/Highlight";
import { Paper } from "@/components/scrap/Paper";
import { Button } from "@/components/ui/button";
import {
  copyLink,
  createShare,
  forgetShareUrl,
  recallShareUrl,
  rememberShareUrl,
  revokeShare,
  shareOrCopy,
} from "@/lib/client/share";
import { SUBMIT_TEXT } from "@/lib/client/submit";
import { TONES } from "@/lib/llm/concepts";
import { type ConversationView, kstDay, SERIES_TITLE } from "./model";

const SHARE_TEXT = {
  notice: (expiresAt: string) =>
    `링크를 받은 사람은 초대 코드 없이 읽을 수 있어요. 표시 이름과 인용된 대화 원문이 함께 보여요. 대화와 함께 ${kstDay(expiresAt)}에 사라져요`,
  otherDevice: "이 기기에서 만든 링크가 아니에요. 새 링크가 필요하면 폐기 후 다시 만드세요",
  revokeWarning: "폐기하면 이전 링크는 바로 열리지 않아요(404). 다시 공유하려면 새 링크를 만들어야 해요.",
  revoked: "링크를 폐기했어요. 이전 링크는 이제 열리지 않아요.",
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

export function SharePanel({ id, conversation: c, onChanged }: { id: string; conversation: ConversationView; onChanged: () => Promise<void> }) {
  // 이 영역은 대화를 불러온 뒤 브라우저에서만 그려진다(서버 렌더 때는 PageState)
  const [url, setUrl] = useState<string | null>(() => recallShareUrl(id));
  const [canShare] = useState(() => typeof navigator !== "undefined" && typeof navigator.share === "function");
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  /** 다시 그리기 전의 두 번째 탭도 막는다(동시 요청은 409가 된다) */
  const inFlight = useRef(false);

  // 리포트가 아직 없고 공유 중도 아니면 보여 줄 것이 없다. 공유 중이면 폐기할 수 있어야 한다
  if (c.report.content === null && !c.shared) return null;

  const title = `${SERIES_TITLE[c.concept]} · ${TONES[c.tone].label}`;
  const link = c.shared ? url : null;

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

  /** [링크 만들기]. 새 링크가 나오면 기억하고 바로 보내기·복사로 간다 */
  async function submit(): Promise<Notice> {
    const r = await createShare(id);
    if (!r.ok) return failure(r.status);
    let next: Notice;
    if (r.url) {
      rememberShareUrl(id, r.url);
      setUrl(r.url);
      next = RESULT_NOTICE[await shareOrCopy(r.url, title)];
    } else {
      // 다른 탭이 먼저 만들었다. 링크는 기억해 둔 것을 그대로 쓴다(없으면 다른 기기에서 만든 링크다)
      setUrl(recallShareUrl(id));
      next = null;
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

  return (
    <Paper as="section" aria-labelledby="share-title" tilt="right" calm className="grid gap-3 pt-6">
      <h2 id="share-title" className="text-[1.375rem] leading-tight font-bold tracking-tight">
        <Highlight color="mint">공유</Highlight>
      </h2>
      <p className="text-base text-muted-foreground">{SHARE_TEXT.notice(c.expiresAt)}</p>

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
