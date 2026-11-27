// /s/[token] 공유 화면 본문: 리포트(표지 → 폴라로이드 → 섹션 → 근거)가 #report-capture 안이고 [나도 해보기]만 그 바깥 아래다.
// 리포트가 없으면(쓰는 중·실패) 표지 + 안내만 보인다. 훅이 없어 서버 컴포넌트에서 그린다(dev 미리보기·/demo도 같은 것을 쓴다).
// v2.8: notice가 있으면(/demo의 "가짜 대화로 만든 데모예요") 리포트 위 바깥에 둔다(DESIGN.md: 알림은 위쪽 바깥)
import Link from "next/link";
import type { ReactNode } from "react";
import { Highlight } from "@/components/scrap/Highlight";
import { Paper } from "@/components/scrap/Paper";
import { tapeAt } from "@/components/scrap/tilt";
import { KpiPolaroids } from "@/components/stats/KpiPolaroids";
import { buttonVariants } from "@/components/ui/button";
import type { Tone } from "@/lib/llm/concepts";
import type { StoredReport } from "@/lib/llm/schema";
import type { ChatStats } from "@/lib/stats/compute";
import { CoverStickers } from "./CoverStickers";
import { AI_NOTICE, SERIES_TITLE } from "./model";
import { PageFrame, ReportCapture } from "./PageState";
import { ReportView } from "./ReportView";

/** lib/server/handlers/shares의 SharedView와 같은 모양 */
export interface SharedReportData {
  concept: "group" | "couple";
  tone: Tone;
  displayNames: string[];
  stats: ChatStats;
  report: StoredReport | null;
}

export function SharedReport({ view, notice }: { view: SharedReportData; notice?: ReactNode }) {
  const kicker = `${SERIES_TITLE[view.concept]} · ${AI_NOTICE}`;
  const stickers = <CoverStickers tone={view.tone} names={view.displayNames} dailyCounts={view.stats.dailyCounts} />;
  const snapshot = <KpiPolaroids stats={view.stats} />;
  return (
    <PageFrame>
      {notice}
      <ReportCapture>
        {view.report ? (
          <ReportView
            content={view.report}
            stats={view.stats}
            kicker={kicker}
            fallbackTitle={SERIES_TITLE[view.concept]}
            stickers={stickers}
            snapshot={snapshot}
          />
        ) : (
          <>
            <Paper as="header" tilt="left" tape={tapeAt(0)} className="grid gap-3 px-5 pt-7 pb-5">
              <p className="text-[0.8125rem] text-ink-soft">{kicker}</p>
              <h1 className="text-[1.75rem] leading-tight font-bold tracking-tight">
                <Highlight>{SERIES_TITLE[view.concept]}</Highlight>
              </h1>
              {stickers}
            </Paper>
            {snapshot}
            <Paper tilt="right" calm className="text-base">
              보여 줄 리포트가 없어요.
            </Paper>
          </>
        )}
      </ReportCapture>

      <Link href="/" className={buttonVariants({ size: "lg" })}>
        나도 해보기
      </Link>
    </PageFrame>
  );
}
