// /s/[token] 공유 화면 본문: 표지(고지·컨셉·기간·이름 스티커) → 폴라로이드 → 보여 줄 편들. 모두 #report-capture 안이고
// [나도 해보기]만 그 바깥 아래다. 훅이 없어 서버 컴포넌트에서 그린다(dev 미리보기도 같은 것을 쓴다)
import Link from "next/link";
import { Paper } from "@/components/scrap/Paper";
import { tapeAt } from "@/components/scrap/tilt";
import { KpiPolaroids } from "@/components/stats/KpiPolaroids";
import { buttonVariants } from "@/components/ui/button";
import type { StoredEpisode } from "@/lib/llm/schema";
import type { ChatStats } from "@/lib/stats/compute";
import { CoverStickers } from "./CoverStickers";
import { EpisodeView } from "./EpisodeView";
import { AI_NOTICE } from "./model";
import { PageFrame, ReportCapture } from "./PageState";

/** lib/server/handlers/shares의 SharedView와 같은 모양 */
export interface SharedReportData {
  concept: "group" | "couple";
  displayNames: string[];
  stats: ChatStats;
  episodes: { n: number; content: StoredEpisode }[];
}

export function SharedReport({ view }: { view: SharedReportData }) {
  return (
    <PageFrame>
      <ReportCapture>
        <Paper as="header" tilt="left" tape={tapeAt(0)} className="grid gap-3 px-5 pt-7 pb-5">
          <p className="text-[0.8125rem] text-ink-soft">{AI_NOTICE}</p>
          <CoverStickers concept={view.concept} names={view.displayNames} dailyCounts={view.stats.dailyCounts} suffix="의 대화" />
        </Paper>
        <KpiPolaroids stats={view.stats} />

        {view.episodes.length === 0 ? (
          <Paper tilt="right" calm className="text-base">
            보여 줄 편이 없어요.
          </Paper>
        ) : (
          view.episodes.map((e) => <EpisodeView key={e.n} n={e.n} content={e.content} stats={view.stats} />)
        )}
      </ReportCapture>

      <Link href="/" className={buttonVariants({ size: "lg" })}>
        나도 해보기
      </Link>
    </PageFrame>
  );
}
