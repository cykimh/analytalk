"use client";

// /c/[id]/steps: 편마다 상태와 진행 메모(검증을 거친 reading_notes)를 쌓아 보여 준다.
// AI가 생각하는 동안에는 통계 카드를 돌아가며 보여 주고, 1편이 끝나면 [1편 읽기]를 띄운다.
// 인용·본문은 이 화면에 나오지 않는다(검증을 통과한 편 화면에서만 보인다).
// 메모의 {{stat:경로}}는 대화 통계로 채우므로, 통계(대화)를 받은 뒤에 메모를 그린다.
// 진행 기록은 #report-capture 안에, [1편 읽기]·[대화 홈]은 그 바깥 아래에 둔다
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Highlight } from "@/components/scrap/Highlight";
import { Paper } from "@/components/scrap/Paper";
import { alternate, tapeAt } from "@/components/scrap/tilt";
import { buttonVariants } from "@/components/ui/button";
import { hasStatText } from "@/lib/episode/statText";
import type { ChatStats } from "@/lib/stats/compute";
import { AI_NOTICE, type ConversationView, isActive, type Note, PAUSED_TEXT, SAFETY_HELP, statCards, STATUS_TEXT, type StatusView } from "./model";
import { blocking, PageFrame, PageState, ReportCapture } from "./PageState";
import { StatText } from "./StatText";
import { useConversation } from "./useConversation";

const STAT_ROTATE_MS = 4000;

/** 기다리는 동안 볼 통계 카드 하나씩(노란 메모지). 바뀔 때마다 읽어 주지 않는다(aria-live off) */
function StatTicker({ stats }: { stats: ChatStats }) {
  const cards = useMemo(() => statCards(stats), [stats]);
  const [i, setI] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setI((x) => x + 1), STAT_ROTATE_MS);
    return () => clearInterval(timer);
  }, []);
  const card = cards[i % cards.length];
  return (
    <Paper
      as="section"
      aria-label="기다리는 동안 볼 통계"
      aria-live="off"
      tone="butter"
      tilt="right"
      tape={tapeAt(1)}
      className="grid gap-1 justify-self-center px-6 pt-6 pb-5 text-center"
    >
      <p className="text-base leading-tight font-bold">{card.label}</p>
      <p className="truncate text-3xl font-bold tabular-nums">{card.value}</p>
    </Paper>
  );
}

/** 불러온 상태로 그린 진행 화면(데이터는 StepsFeed·dev 미리보기가 넣는다). conversation은 아직 없을 수 있다 */
export function StepsFeedView({
  id,
  conversation,
  status,
  notes,
}: {
  id: string;
  conversation: ConversationView | null;
  status: StatusView;
  notes: Record<number, Note[]>;
}) {
  const episodes = status.episodes;
  const first = episodes.find((e) => e.n === 1)?.status;
  const active = isActive(episodes);
  const stats = conversation?.stats ?? null;

  return (
    <PageFrame>
      <ReportCapture>
        <Paper as="header" tilt="left" tape={tapeAt(0)} className="grid gap-2 px-5 pt-7 pb-5">
          <p className="text-[0.8125rem] text-ink-soft">{AI_NOTICE}</p>
          <h1 className="text-[1.625rem] leading-tight font-bold tracking-tight">
            <Highlight>{active ? "AI가 대화를 읽고 있어요" : "AI 연재 진행 상황"}</Highlight>
          </h1>
          <p className="text-base text-ink-soft">창을 닫아도 서버에서 계속 써요. 끝난 편부터 대화 홈에서 읽을 수 있어요.</p>
        </Paper>

        {status.paused && (
          <p role="note" className="rounded-lg border border-dashed border-ink/25 bg-sheet/80 p-3 text-base">
            {PAUSED_TEXT}이에요. 다시 쓰기는 마감이 풀린 뒤에 할 수 있어요.
          </p>
        )}

        {active && stats && <StatTicker stats={stats} />}

        <ol className="grid grid-cols-1 gap-6">
          {episodes.map((e) => {
            // 채운 뒤 빈 메모(모르는 자리표시자뿐)는 그리지 않는다
            const shown = stats ? (notes[e.n] ?? []).filter((note) => hasStatText(note.note, stats)) : [];
            return (
              <Paper as="li" key={e.n} tilt={alternate(e.n)} calm tape={tapeAt(e.n + 1)} className="grid grid-cols-1 gap-2 pt-6">
                <h2 className="text-[1.125rem] leading-tight font-bold">
                  {e.n}편 <span className="font-normal text-ink-soft">· {STATUS_TEXT[e.status] ?? e.status}</span>
                </h2>
                {stats && shown.length > 0 && (
                  <ul className="grid grid-cols-1 gap-2 text-base leading-relaxed">
                    {shown.map((note) => (
                      <li key={`${note.range}|${note.note}`} className="flex min-w-0 gap-2">
                        <span className="shrink-0 pt-0.5 text-sm text-ink-soft tabular-nums">
                          <StatText text={note.range} stats={stats} />
                        </span>
                        <span className="min-w-0 wrap-anywhere">
                          <StatText text={note.note} stats={stats} />
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Paper>
            );
          })}
        </ol>

        {first === "failed" && <p className="text-base">1편을 쓰지 못했어요. 대화 홈에서 [다시 쓰기]를 눌러 주세요.</p>}
        {first === "refused" && <p className="text-base">AI가 이 대화로는 연재를 쓰지 않았어요. 이번 달 횟수는 줄지 않아요.</p>}
        {first === "safety" && <p className="text-base">{SAFETY_HELP}</p>}
      </ReportCapture>

      <div className="flex flex-wrap gap-2">
        {(first === "done" || first === "partial") && (
          <Link href={`/c/${id}/e/1`} className={buttonVariants({ size: "lg" })}>
            1편 읽기
          </Link>
        )}
        <Link href={`/c/${id}`} className={buttonVariants({ size: "lg", variant: "outline" })}>
          대화 홈
        </Link>
      </div>
    </PageFrame>
  );
}

export function StepsFeed({ id }: { id: string }) {
  const { conversation, status, notes, error, reload } = useConversation(id);
  if (blocking(error, status !== null)) return <PageState error={error} onReload={reload} />;
  return <StepsFeedView id={id} conversation={conversation} status={status!} notes={notes} />;
}
