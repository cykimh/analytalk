"use client";

// /c/[id] 대화 홈: 표지(제목·스티커·읽은 범위·삭제 예정일) + 폴라로이드 → AI 리포트 카드(상태·진행 메모·[리포트 읽기]·[다시 쓰기]) → 공유 → 통계 → [지금 삭제].
// 표지와 폴라로이드만 #report-capture 안이다. 버튼이 든 리포트 카드·공유·삭제는 그 바깥 아래에 둔다(DESIGN.md).
// 만들면 바로 이 화면으로 온다. 탭을 다시 열어도 API에서 상태를 불러오고, 쓰는 동안 폴링해 끝나면 [리포트 읽기]를 연다.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Highlight } from "@/components/scrap/Highlight";
import { Paper } from "@/components/scrap/Paper";
import { alternate, tapeAt } from "@/components/scrap/tilt";
import { KpiPolaroids } from "@/components/stats/KpiPolaroids";
import { StatsDashboard } from "@/components/stats/StatsDashboard";
import { Button, buttonVariants } from "@/components/ui/button";
import { deletePayload } from "@/lib/client/idb";
import { forgetSeries } from "@/lib/client/recent";
import type { SubmitResult } from "@/lib/client/submit";
import { hasStatText } from "@/lib/episode/statText";
import type { ChatStats } from "@/lib/stats/compute";
import { CoverStickers } from "./CoverStickers";
import {
  AI_NOTICE,
  type ConversationView,
  isActive,
  kstDay,
  type Note,
  PAUSED_TEXT,
  RETRY_KEPT_TEXT,
  readRange,
  reportAction,
  reportPhase,
  retryKept,
  SAFETY_HELP,
  SERIES_TITLE,
  type StatusView,
} from "./model";
import { blocking, PageFrame, PageState, ReportCapture } from "./PageState";
import { SharePanel } from "./SharePanel";
import { StatText } from "./StatText";
import { useConversation } from "./useConversation";

/** 가장 최근 읽기 메모 한 줄(채운 뒤 빈 것은 건너뛴다). 인용·본문은 이 화면에 나오지 않는다 */
function latestNote(notes: Note[], stats: ChatStats): Note | null {
  for (let i = notes.length - 1; i >= 0; i--) if (hasStatText(notes[i].note, stats)) return notes[i];
  return null;
}

function ReportCard({
  conversation: c,
  id,
  status: live,
  notes,
  onRetry,
}: {
  conversation: ConversationView;
  id: string;
  status: StatusView | null;
  notes: Note[];
  onRetry: () => Promise<SubmitResult>;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const status = live?.report.status ?? c.report.status;
  const errorCode = live ? live.report.errorCode : c.report.errorCode;
  const note = latestNote(notes, c.stats);
  const action = reportAction(status, live?.paused ?? false);

  async function retry() {
    setBusy(true);
    setMessage(null);
    const r = await onRetry();
    if (!r.ok) setMessage(r.message);
    setBusy(false);
  }

  return (
    <Paper as="section" aria-labelledby="report-title" tilt="right" calm className="grid grid-cols-1 content-start gap-2 pt-6">
      <h2 id="report-title" className="text-[1.375rem] leading-tight font-bold tracking-tight">
        <Highlight color="mint">AI 리포트</Highlight>
      </h2>
      <p className="text-base leading-tight text-ink-soft">{reportPhase(status, note !== null)}</p>
      {isActive(status) && (
        <>
          {note && (
            <p className="text-base leading-relaxed wrap-anywhere">
              <StatText text={note.note} stats={c.stats} />
            </p>
          )}
          <p className="text-base text-muted-foreground">창을 닫아도 서버에서 계속 써요.</p>
        </>
      )}
      {status === "refused" && <p className="text-base text-muted-foreground">이번 달 횟수는 줄지 않아요.</p>}
      {status === "safety" && <p className="text-base">{SAFETY_HELP}</p>}
      {retryKept(status, errorCode) && <p className="text-base text-muted-foreground">{RETRY_KEPT_TEXT}</p>}
      {(action.read || action.retry) && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {action.read && (
            <Link href={`/c/${id}/report`} className={buttonVariants()}>
              리포트 읽기
            </Link>
          )}
          {action.retry === "button" && (
            <Button variant="outline" disabled={busy} onClick={retry}>
              다시 쓰기
            </Button>
          )}
          {action.retry === "paused" && <span className="text-base text-muted-foreground">{PAUSED_TEXT}</span>}
        </div>
      )}
      {message && (
        <p role="alert" className="text-base text-destructive">
          {message}
        </p>
      )}
    </Paper>
  );
}

/** [지금 삭제] → 한 번 더 묻고 DELETE. 이 브라우저의 페이로드도 지운다 */
function DeleteBox({ id }: { id: string }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
      // 404: 이미 지워졌거나 만료됐다
      if (res.status === 204 || res.status === 404) {
        await deletePayload(id).catch(() => undefined);
        forgetSeries(id);
        router.replace("/");
        return;
      }
    } catch {
      // 아래 문구
    }
    setError("지우지 못했어요. 잠시 뒤 다시 시도해 주세요.");
    setBusy(false);
  }

  return (
    <section aria-labelledby="delete-title" className="grid gap-2 rounded-[3px] border border-dashed border-ink/25 bg-sheet/70 p-4">
      <h2 id="delete-title" className="text-base font-bold">
        대화 지우기
      </h2>
      <p className="text-base text-muted-foreground">리포트와 통계, 이 대화로 남긴 피드백이 모두 지워지고 되돌릴 수 없어요.</p>
      {asking ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="destructive" disabled={busy} onClick={remove}>
            정말 지우기
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setAsking(false)}>
            취소
          </Button>
        </div>
      ) : (
        <Button variant="destructive" className="justify-self-start" onClick={() => setAsking(true)}>
          지금 삭제
        </Button>
      )}
      {error && (
        <p role="alert" className="text-base text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

/** 불러온 대화로 그린 대화 홈(데이터·핸들러는 ConversationHome·dev 미리보기가 넣는다) */
export function ConversationHomeView({
  id,
  conversation: c,
  status,
  notes,
  retry,
  reload,
}: {
  id: string;
  conversation: ConversationView;
  status: StatusView | null;
  notes: Note[];
  retry: () => Promise<SubmitResult>;
  reload: () => Promise<void>;
}) {
  return (
    <PageFrame>
      <ReportCapture>
        <Paper as="header" tilt="left" tape={tapeAt(0)} className="grid gap-3 px-5 pt-7 pb-5">
          <p className="text-[0.8125rem] text-ink-soft">{AI_NOTICE}</p>
          <h1 className="text-[1.75rem] leading-tight font-bold tracking-tight">
            <Highlight>{SERIES_TITLE[c.concept]}</Highlight>
          </h1>
          <CoverStickers tone={c.tone} names={c.displayNames} dailyCounts={c.stats.dailyCounts} />
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 pt-1 text-base">
            <dt className="text-ink-soft">읽은 범위</dt>
            <dd className="tabular-nums">{readRange(c.msgSent)}</dd>
            <dt className="text-ink-soft">삭제 예정일</dt>
            <dd className="tabular-nums">{kstDay(c.expiresAt)} (30일 보관)</dd>
          </dl>
        </Paper>
        <KpiPolaroids stats={c.stats} />
      </ReportCapture>

      <ReportCard id={id} conversation={c} status={status} notes={notes} onRetry={retry} />

      <SharePanel id={id} conversation={c} onChanged={reload} />

      <section aria-labelledby="stats-title" className="grid gap-5">
        <h2 id="stats-title" className="text-[1.375rem] leading-tight font-bold tracking-tight">
          <Highlight>대화 통계</Highlight>
        </h2>
        <StatsDashboard stats={c.stats} kind={c.kind} look="scrap" />
      </section>

      <DeleteBox id={id} />
    </PageFrame>
  );
}

export function ConversationHome({ id }: { id: string }) {
  const { conversation, status, notes, error, retry, reload } = useConversation(id);
  if (blocking(error, conversation !== null)) return <PageState error={error} onReload={reload} />;
  return <ConversationHomeView id={id} conversation={conversation!} status={status} notes={notes} retry={retry} reload={reload} />;
}
