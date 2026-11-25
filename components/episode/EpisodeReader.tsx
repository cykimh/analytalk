"use client";

// /c/[id]/e/[n]: 검증을 통과해 저장된 편을 읽는다. 아직 쓰는 중이면 진행 화면으로, 못 쓴 편은 대화 홈으로 안내한다.
// 리포트(표지 → 폴라로이드 → 섹션 → 근거)는 #report-capture 안에, 문단 [틀렸어요]·다음 편 버튼은 그 바깥 아래에 둔다
import Link from "next/link";
import { Paper } from "@/components/scrap/Paper";
import { tapeAt } from "@/components/scrap/tilt";
import { KpiPolaroids } from "@/components/stats/KpiPolaroids";
import { buttonVariants } from "@/components/ui/button";
import { CoverStickers } from "./CoverStickers";
import { EpisodeView } from "./EpisodeView";
import { type ConversationView, SAFETY_HELP, STATUS_TEXT } from "./model";
import { blocking, PageFrame, PageState, ReportCapture } from "./PageState";
import { ParagraphFeedback } from "./ParagraphFeedback";
import { useConversation } from "./useConversation";

/** 불러온 대화로 그린 편 화면(데이터는 EpisodeReader·dev 미리보기가 넣는다) */
export function EpisodeReaderView({ id, n, conversation: c }: { id: string; n: number; conversation: ConversationView }) {
  const episode = c.episodes.find((e) => e.n === n);
  const next = c.episodes.find((e) => e.n === n + 1);
  const status = episode?.status;

  return (
    <PageFrame>
      <nav>
        <Link href={`/c/${id}`} className="inline-flex min-h-11 items-center text-base text-ink-soft underline-offset-4 hover:underline">
          ← 대화 홈
        </Link>
      </nav>

      {episode?.content ? (
        <>
          {status === "partial" && (
            <p role="note" className="rounded-lg border border-dashed border-ink/25 bg-sheet/80 p-3 text-base">
              일부 문단만 남았어요. 대화 홈에서 [다시 쓰기]로 다시 쓸 수 있어요.
            </p>
          )}
          <ReportCapture>
            <EpisodeView
              n={n}
              content={episode.content}
              stats={c.stats}
              stickers={<CoverStickers concept={c.concept} names={c.displayNames} dailyCounts={c.stats.dailyCounts} />}
              snapshot={<KpiPolaroids stats={c.stats} />}
            />
          </ReportCapture>
          <ParagraphFeedback id={id} n={n} content={episode.content} stats={c.stats} />
        </>
      ) : (
        <Paper tilt="left" tape={tapeAt(0)} className="grid gap-3 pt-6 text-base">
          <p className="text-base font-bold">
            {n}편 · {STATUS_TEXT[status ?? ""] ?? "아직 없어요"}
          </p>
          {status === "safety" && <p>{SAFETY_HELP}</p>}
          {(status === "queued" || status === "running") && (
            <Link href={`/c/${id}/steps`} className={buttonVariants({ variant: "outline", className: "justify-self-start" })}>
              진행 상황 보기
            </Link>
          )}
        </Paper>
      )}

      {next?.content && (
        <Link href={`/c/${id}/e/${n + 1}`} className={buttonVariants({ size: "lg" })}>
          {n + 1}편 읽기
        </Link>
      )}
    </PageFrame>
  );
}

export function EpisodeReader({ id, n }: { id: string; n: number }) {
  const { conversation, error, reload } = useConversation(id);
  if (blocking(error, conversation !== null)) return <PageState error={error} onReload={reload} />;
  return <EpisodeReaderView id={id} n={n} conversation={conversation!} />;
}
