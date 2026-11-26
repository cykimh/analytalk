// 리포트 한 편: 표지 카드(킥커·헤드라인·dek·스티커) → (있으면) 폴라로이드 → 섹션 카드(아이콘 스티커·제목·문단 → 근거 메모지).
// 킥커에 'AI 생성, 재미·참고용'을 단다. 모든 글은 React 텍스트 노드로만 그린다. 모델이 쓴 글은 모두 StatText로 그려
// {{stat:경로}}를 통계 값으로 채운다. 채운 뒤 빈 헤드라인은 fallbackTitle로, 빈 dek는 그리지 않는다.
// 문단 [틀렸어요]는 여기 없다: 리포트 화면이 #report-capture 바깥 아래에 ParagraphFeedback으로 둔다.
// 띄어 쓰지 않은 긴 글(ㅋ 줄, 붙여 쓴 문장)은 keep-all에서 끊을 곳이 없는 한 단어다. 글이 든 grid는 grid-cols-1(minmax(0,1fr))로
// 칸이 그 단어 폭만큼 넓어지지 않게 하고, 모델이 쓴 글은 wrap-anywhere로 카드 폭에서 줄을 바꾼다(DESIGN.md 레이아웃)
import type { ReactNode } from "react";
import { Highlight } from "@/components/scrap/Highlight";
import { Paper } from "@/components/scrap/Paper";
import { Sticker } from "@/components/scrap/Sticker";
import { alternate, highlightAt, tapeAt } from "@/components/scrap/tilt";
import { hasStatText } from "@/lib/episode/statText";
import type { StoredEpisode } from "@/lib/llm/schema";
import type { ChatStats } from "@/lib/stats/compute";
import { Evidence } from "./Evidence";
import { StatText } from "./StatText";

export function ReportView({
  content,
  stats,
  kicker,
  fallbackTitle,
  stickers,
  snapshot,
}: {
  content: StoredEpisode;
  stats: ChatStats;
  /** 표지 맨 위 한 줄(제목 종류 · AI 고지) */
  kicker: string;
  /** 채운 뒤 헤드라인이 비었을 때 */
  fallbackTitle: string;
  /** 표지 카드 아래쪽 스티커 줄(CoverStickers) */
  stickers?: ReactNode;
  /** 표지 다음, 섹션 앞(KpiPolaroids) */
  snapshot?: ReactNode;
}) {
  return (
    <article className="grid min-w-0 grid-cols-1 gap-8">
      <Paper as="header" tilt="left" tape={tapeAt(0)} className="grid grid-cols-1 gap-3 px-5 pt-7 pb-5">
        <p className="text-[0.8125rem] text-ink-soft">{kicker}</p>
        <h1 className="text-[1.75rem] leading-[1.2] font-bold wrap-anywhere tracking-tight">
          <Highlight color={highlightAt(0)}>
            {hasStatText(content.headline, stats) ? <StatText text={content.headline} stats={stats} /> : fallbackTitle}
          </Highlight>
        </h1>
        {hasStatText(content.dek, stats) && (
          <p className="text-[1.0625rem] leading-relaxed text-ink-soft wrap-anywhere">
            <StatText text={content.dek} stats={stats} />
          </p>
        )}
        {stickers && <div className="pt-1">{stickers}</div>}
      </Paper>

      {snapshot}

      {content.sections.map((section, si) => (
        <Paper
          as="section"
          key={`${si}-${section.title}`}
          tilt={alternate(si + 1)}
          calm
          className="grid grid-cols-1 gap-4 px-5 pt-7 pb-6"
        >
          <h2 className="flex min-w-0 items-start gap-2 text-[1.25rem] leading-tight font-bold wrap-anywhere tracking-tight">
            <Sticker aria-hidden index={si} className="mt-0.5 shrink-0 px-1.5 font-sans text-lg leading-none">
              {section.icon}
            </Sticker>
            <span className="min-w-0">
              <Highlight color={highlightAt(si + 1)}>
                <StatText text={section.title} stats={stats} />
              </Highlight>
            </span>
          </h2>
          {section.paragraphs.map((p, pi) => (
            <p key={`${pi}-${p.key}`} className="text-[1.0625rem] leading-[1.8] wrap-anywhere">
              <StatText text={p.text} stats={stats} />
            </p>
          ))}
          {section.evidence.length > 0 && (
            <div className="grid grid-cols-1 gap-3 pt-1">
              {section.evidence.map((e, ei) => (
                <Evidence key={e.id} index={ei} sender={e.sender} at={e.at} quote={e.quote} />
              ))}
            </div>
          )}
        </Paper>
      ))}
    </article>
  );
}
