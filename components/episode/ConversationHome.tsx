"use client";

// /c/[id] 대화 홈: 표지(제목·스티커·읽은 범위·삭제 예정일) + 폴라로이드 → 4편 카드([읽기]·[다시 쓰기]) → [공유] → 통계 → [지금 삭제].
// 표지와 폴라로이드만 #report-capture 안이다. 버튼이 든 편 카드·공유·삭제는 그 바깥 아래에 둔다(DESIGN.md).
// 탭을 다시 열어도 API에서 상태를 불러오고, 쓰는 편이 있으면 폴링해 끝난 편부터 연다.
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
import type { StoredEpisode } from "@/lib/llm/schema";
import type { ChatStats } from "@/lib/stats/compute";
import { CoverStickers } from "./CoverStickers";
import {
  AI_NOTICE,
  type ConversationView,
  episodeAction,
  kstDay,
  PAUSED_TEXT,
  RETRY_KEPT_TEXT,
  readRange,
  retryKept,
  SAFETY_HELP,
  SERIES_TITLE,
  STATUS_TEXT,
  type StatusView,
} from "./model";
import { blocking, PageFrame, PageState, ReportCapture } from "./PageState";
import { SharePanel } from "./SharePanel";
import { StatText } from "./StatText";
import { useConversation } from "./useConversation";

function EpisodeCard({
  id,
  n,
  status,
  errorCode,
  content,
  stats,
  paused,
  onRetry,
}: {
  id: string;
  n: number;
  status: string;
  errorCode: string | null;
  content: StoredEpisode | null;
  stats: ChatStats;
  paused: boolean;
  onRetry: (n: number) => Promise<SubmitResult>;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const action = episodeAction(status, paused, n);

  async function retry() {
    setBusy(true);
    setMessage(null);
    const r = await onRetry(n);
    if (!r.ok) setMessage(r.message);
    setBusy(false);
  }

  return (
    <Paper as="section" aria-label={`${n}편`} tilt={alternate(n)} className="grid grid-cols-1 content-start gap-2 pt-6">
      <p className="text-base leading-tight text-ink-soft">
        {n}편 · {STATUS_TEXT[status] ?? status}
      </p>
      {content && (
        <h3 className="text-[1.25rem] leading-snug font-bold wrap-anywhere tracking-tight">
          {hasStatText(content.headline, stats) ? <StatText text={content.headline} stats={stats} /> : `${n}편`}
        </h3>
      )}
      {status === "safety" && <p className="text-base">{SAFETY_HELP}</p>}
      {retryKept(status, errorCode) && <p className="text-base text-muted-foreground">{RETRY_KEPT_TEXT}</p>}
      {(action.read || action.retry) && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {action.read && (
            <Link href={`/c/${id}/e/${n}`} className={buttonVariants()}>
              {n}편 읽기
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
      <p className="text-base text-muted-foreground">4편과 통계, 이 대화로 남긴 피드백이 모두 지워지고 되돌릴 수 없어요.</p>
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
  retry,
  reload,
}: {
  id: string;
  conversation: ConversationView;
  status: StatusView | null;
  retry: (n: number) => Promise<SubmitResult>;
  reload: () => Promise<void>;
}) {
  const paused = status?.paused ?? false;

  return (
    <PageFrame>
      <ReportCapture>
        <Paper as="header" tilt="left" tape={tapeAt(0)} className="grid gap-3 px-5 pt-7 pb-5">
          <p className="text-[0.8125rem] text-ink-soft">{AI_NOTICE}</p>
          <h1 className="text-[1.75rem] leading-tight font-bold tracking-tight">
            <Highlight>{SERIES_TITLE[c.concept]}</Highlight>
          </h1>
          <CoverStickers concept={c.concept} names={c.displayNames} dailyCounts={c.stats.dailyCounts} />
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 pt-1 text-base">
            <dt className="text-ink-soft">읽은 범위</dt>
            <dd className="tabular-nums">{readRange(c.cutoffAt, c.msgSent)}</dd>
            <dt className="text-ink-soft">삭제 예정일</dt>
            <dd className="tabular-nums">{kstDay(c.expiresAt)} (30일 보관)</dd>
          </dl>
        </Paper>
        <KpiPolaroids stats={c.stats} />
      </ReportCapture>

      <section aria-labelledby="episodes-title" className="grid gap-5">
        <h2 id="episodes-title" className="text-[1.375rem] leading-tight font-bold tracking-tight">
          <Highlight color="mint">연재 4편</Highlight>
        </h2>
        <div className="grid gap-6">
          {c.episodes.map((e) => {
            const live = status?.episodes.find((s) => s.n === e.n);
            return (
              <EpisodeCard
                key={e.n}
                id={id}
                n={e.n}
                status={live?.status ?? e.status}
                errorCode={live ? live.errorCode : e.errorCode}
                content={e.content}
                stats={c.stats}
                paused={paused}
                onRetry={retry}
              />
            );
          })}
        </div>
      </section>

      <SharePanel id={id} conversation={c} onChanged={reload} />

      <section aria-labelledby="stats-title" className="grid gap-5">
        <h2 id="stats-title" className="text-[1.375rem] leading-tight font-bold tracking-tight">
          <Highlight>대화 통계</Highlight>
        </h2>
        <StatsDashboard stats={c.stats} kind={c.kind} me="" look="scrap" />
      </section>

      <DeleteBox id={id} />
    </PageFrame>
  );
}

export function ConversationHome({ id }: { id: string }) {
  const { conversation, status, error, retry, reload } = useConversation(id);
  if (blocking(error, conversation !== null)) return <PageState error={error} onReload={reload} />;
  return <ConversationHomeView id={id} conversation={conversation!} status={status} retry={retry} reload={reload} />;
}
