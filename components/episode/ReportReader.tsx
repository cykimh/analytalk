"use client";

// /c/[id]/report: 검증을 통과해 저장된 리포트를 읽는다. 아직 쓰는 중이거나 못 쓴 리포트는 상태 카드와 [대화 홈에서 진행 보기]로 안내한다.
// 리포트(표지 → 폴라로이드 → 종합·멤버별·마무리 섹션 → 근거)는 #report-capture 안에 둔다
import Link from "next/link";
import { Paper } from "@/components/scrap/Paper";
import { tapeAt } from "@/components/scrap/tilt";
import { KpiPolaroids } from "@/components/stats/KpiPolaroids";
import { buttonVariants } from "@/components/ui/button";
import { CoverStickers } from "./CoverStickers";
import { AI_NOTICE, type ConversationView, reportPhase, SAFETY_HELP, SERIES_TITLE } from "./model";
import { blocking, PageFrame, PageState, ReportCapture } from "./PageState";
import { ReportView } from "./ReportView";
import { useConversation } from "./useConversation";

/** 불러온 대화로 그린 리포트 화면(데이터는 ReportReader·dev 미리보기가 넣는다) */
export function ReportReaderView({ id, conversation: c }: { id: string; conversation: ConversationView }) {
  const { status, content } = c.report;

  return (
    <PageFrame>
      <nav>
        <Link href={`/c/${id}`} className="inline-flex min-h-11 items-center text-base text-ink-soft underline-offset-4 hover:underline">
          ← 대화 홈
        </Link>
      </nav>

      {content ? (
        <>
          {status === "partial" && (
            <p role="note" className="rounded-lg border border-dashed border-ink/25 bg-sheet/80 p-3 text-base">
              일부 문단만 남았어요. 대화 홈에서 [다시 쓰기]로 다시 쓸 수 있어요.
            </p>
          )}
          <ReportCapture>
            <ReportView
              content={content}
              stats={c.stats}
              kicker={`${SERIES_TITLE[c.concept]} · ${AI_NOTICE}`}
              fallbackTitle={SERIES_TITLE[c.concept]}
              stickers={<CoverStickers tone={c.tone} names={c.displayNames} dailyCounts={c.stats.dailyCounts} />}
              snapshot={<KpiPolaroids stats={c.stats} />}
            />
          </ReportCapture>
        </>
      ) : (
        <Paper tilt="left" tape={tapeAt(0)} className="grid gap-3 pt-6 text-base">
          <p className="text-base font-bold">리포트 · {reportPhase(status, false)}</p>
          {status === "safety" && <p>{SAFETY_HELP}</p>}
          <Link href={`/c/${id}`} className={buttonVariants({ variant: "outline", className: "justify-self-start" })}>
            대화 홈에서 진행 보기
          </Link>
        </Paper>
      )}
    </PageFrame>
  );
}

export function ReportReader({ id }: { id: string }) {
  const { conversation, error, reload } = useConversation(id);
  if (blocking(error, conversation !== null)) return <PageState error={error} onReload={reload} />;
  return <ReportReaderView id={id} conversation={conversation!} />;
}
