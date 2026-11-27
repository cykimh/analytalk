// 리포트 한 편: 표지 카드(킥커·헤드라인·dek·스티커) → (있으면) 폴라로이드 → 섹션 카드(아이콘 스티커·제목·문단마다 그 문단이 처음 쓴 근거 말풍선).
// v2.4: 섹션은 세 부분(종합 → 멤버별 → 마무리, groupStages)으로 묶고 부분마다 작은 머리말을 단다. 사람 섹션이 없는 리포트는 머리말 없이 그린다.
// 킥커에 'AI 생성, 재미·참고용'을 단다. 모든 글은 React 텍스트 노드로만 그린다. 모델이 쓴 글은 모두 StatText로 그려
// {{stat:경로}}를 통계 값으로 채운다. 채운 뒤 빈 헤드라인은 fallbackTitle로, 빈 dek는 그리지 않는다.
// 띄어 쓰지 않은 긴 글(ㅋ 줄, 붙여 쓴 문장)은 keep-all에서 끊을 곳이 없는 한 단어다. 글이 든 grid는 grid-cols-1(minmax(0,1fr))로
// 칸이 그 단어 폭만큼 넓어지지 않게 하고, 모델이 쓴 글은 wrap-anywhere로 카드 폭에서 줄을 바꾼다(DESIGN.md 레이아웃)
// v2.8: 폴라로이드 다음에 하이라이트 한 줄 카드(통계 + 케미 온도)를, 사람 섹션(about이 참여자)의 제목 아래에 칩(ㅋ 유형·MBTI 추측)과
// MBTI 이유 한 줄을 그린다. 칩은 그 사람의 첫 섹션에만 단다. 예전 리포트(케미 온도·MBTI 없음)는 통계로 만든 카드·ㅋ 유형만 보인다
import { Fragment, type ReactNode } from "react";
import { Highlight } from "@/components/scrap/Highlight";
import { Paper } from "@/components/scrap/Paper";
import { ChatRoom } from "@/components/scrap/ChatBubble";
import { Sticker } from "@/components/scrap/Sticker";
import { alternate, highlightAt, tapeAt } from "@/components/scrap/tilt";
import { HighlightCards } from "@/components/stats/HighlightCards";
import { hasStatText } from "@/lib/episode/statText";
import type { StoredReport } from "@/lib/llm/schema";
import type { ChatStats } from "@/lib/stats/compute";
import { highlightCards } from "@/lib/stats/highlights";
import { LAUGH_TYPE_HINT, LAUGH_TYPE_LABEL, laughType } from "@/lib/stats/laughType";
import { Evidence } from "./Evidence";
import { groupStages, placeEvidence, STAGE_LABEL } from "./model";
import { StatText } from "./StatText";

export function ReportView({
  content,
  stats,
  kicker,
  fallbackTitle,
  stickers,
  snapshot,
}: {
  content: StoredReport;
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
  const stages = groupStages(content.sections);
  // 부분이 둘 이상일 때만 머리말을 단다(사람 섹션이 없는 예전·짧은 리포트는 그대로)
  const labeled = stages.length > 1;
  const highlights = highlightCards(stats, { chemistry: content.chemistry });
  // 사람마다 첫 섹션(리포트 전체 순서)에만 칩을 단다(같은 사람을 두 섹션에 쓴 경우)
  const chipAt = new Set<number>();
  const seen = new Set<string>();
  content.sections.forEach((s, i) => {
    if (Object.hasOwn(stats.byPerson, s.about) && !seen.has(s.about)) {
      seen.add(s.about);
      chipAt.add(i);
    }
  });
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

      <HighlightCards cards={highlights} stats={stats} />

      {stages.map(({ stage, sections }) => (
        <div
          key={stage}
          role={labeled ? "group" : undefined}
          aria-labelledby={labeled ? `report-stage-${stage}` : undefined}
          className="grid min-w-0 grid-cols-1 gap-3"
        >
          {labeled && (
            <p id={`report-stage-${stage}`} className="flex items-center gap-3 px-1 text-[0.875rem] font-bold text-ink-soft">
              {STAGE_LABEL[stage]}
              <span aria-hidden className="h-px flex-1 bg-ink/15" />
            </p>
          )}
          <div className="grid min-w-0 grid-cols-1 gap-8">
            {sections.map(({ section, index: si }) => (
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
                <PersonChips name={chipAt.has(si) ? section.about : null} stats={stats} mbti={section.mbti} reason={section.mbti_reason} />
                {placeEvidence(section).map(({ paragraph: p, evidence }, pi) => (
                  <Fragment key={`${pi}-${p?.key ?? "rest"}`}>
                    {p && (
                      <p className="text-[1.0625rem] leading-[1.8] wrap-anywhere">
                        <StatText text={p.text} stats={stats} />
                      </p>
                    )}
                    {/* 한 문단의 근거는 카톡 대화방처럼 한 판에 쌓는다 */}
                    {evidence.length > 0 && (
                      <ChatRoom>
                        {evidence.map(({ e }) => (
                          <Evidence key={e.id} sender={e.sender} at={e.at} quote={e.quote} />
                        ))}
                      </ChatRoom>
                    )}
                  </Fragment>
                ))}
              </Paper>
            ))}
          </div>
        </div>
      ))}
    </article>
  );
}

/**
 * 사람 섹션 제목 아래의 칩 줄(v2.8): ㅋ 유형(통계, 데이터가 모자라면 없음) → MBTI 추측(AI, 검증을 통과했을 때만), 그 아래 MBTI 이유 한 줄.
 * 칩은 한 색(Sticker 기본)이다. 둘 다 없으면 그리지 않는다
 */
function PersonChips({ name, stats, mbti, reason }: { name: string | null; stats: ChatStats; mbti?: string; reason?: string }) {
  if (name === null) return null;
  const laugh = laughType(stats.laughLength[name], stats.byPerson[name] ?? 0);
  if (laugh === null && !mbti) return null;
  return (
    <div className="-mt-1 grid min-w-0 grid-cols-1 gap-2">
      <ul role="list" aria-label={`${name}의 유형`} className="flex min-w-0 flex-wrap items-center gap-1.5">
        {laugh && (
          <li className="min-w-0">
            <Sticker title={LAUGH_TYPE_HINT[laugh]}>ㅋ {LAUGH_TYPE_LABEL[laugh]}</Sticker>
          </li>
        )}
        {mbti && (
          <li className="min-w-0">
            <Sticker title="AI가 대화 습관으로 추측한 MBTI" className="tabular-nums">
              MBTI {mbti}
            </Sticker>
          </li>
        )}
      </ul>
      {mbti && reason && (
        <p className="text-base leading-relaxed text-ink-soft wrap-anywhere">
          <StatText text={reason} stats={stats} />
        </p>
      )}
    </div>
  );
}
