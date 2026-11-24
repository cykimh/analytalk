"use client";

// /c/[id]/steps: 편마다 상태와 진행 메모(검증을 거친 reading_notes)를 쌓아 보여 준다.
// AI가 생각하는 동안에는 통계 카드를 돌아가며 보여 주고, 1편이 끝나면 [1편 읽기]를 띄운다.
// 인용·본문은 이 화면에 나오지 않는다(검증을 통과한 편 화면에서만 보인다)
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import type { ChatStats } from "@/lib/stats/compute";
import { AI_NOTICE, isActive, PAUSED_TEXT, SAFETY_HELP, statCards, STATUS_TEXT } from "./model";
import { blocking, PageFrame, PageState } from "./PageState";
import { useConversation } from "./useConversation";

const STAT_ROTATE_MS = 4000;

/** 기다리는 동안 볼 통계 카드 하나씩. 바뀔 때마다 읽어 주지 않는다(aria-live off) */
function StatTicker({ stats }: { stats: ChatStats }) {
  const cards = useMemo(() => statCards(stats), [stats]);
  const [i, setI] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setI((x) => x + 1), STAT_ROTATE_MS);
    return () => clearInterval(timer);
  }, []);
  const card = cards[i % cards.length];
  return (
    <section aria-label="기다리는 동안 볼 통계" aria-live="off" className="grid gap-1 rounded-xl bg-muted p-4">
      <p className="text-xs text-muted-foreground">{card.label}</p>
      <p className="truncate text-2xl font-semibold tabular-nums">{card.value}</p>
    </section>
  );
}

export function StepsFeed({ id }: { id: string }) {
  const { conversation, status, notes, error, reload } = useConversation(id);
  if (blocking(error, status !== null)) return <PageState error={error} onReload={reload} />;
  const episodes = status!.episodes;
  const first = episodes.find((e) => e.n === 1)?.status;
  const active = isActive(episodes);

  return (
    <PageFrame>
      <header className="grid gap-1">
        <p className="text-xs text-muted-foreground">{AI_NOTICE}</p>
        <h1 className="text-xl font-semibold">{active ? "AI가 대화를 읽고 있어요" : "AI 연재 진행 상황"}</h1>
        <p className="text-sm text-muted-foreground">
          창을 닫아도 서버에서 계속 써요. 끝난 편부터 대화 홈에서 읽을 수 있어요.
        </p>
      </header>

      {status!.paused && (
        <p role="note" className="rounded-xl border p-3 text-sm">
          {PAUSED_TEXT}이에요. 다시 쓰기는 마감이 풀린 뒤에 할 수 있어요.
        </p>
      )}

      {active && conversation && <StatTicker stats={conversation.stats} />}

      <ol className="grid gap-3">
        {episodes.map((e) => (
          <li key={e.n} className="grid gap-2 rounded-xl border p-4">
            <h2 className="text-sm font-semibold">
              {e.n}편 <span className="font-normal text-muted-foreground">· {STATUS_TEXT[e.status] ?? e.status}</span>
            </h2>
            {(notes[e.n]?.length ?? 0) > 0 && (
              <ul className="grid gap-1 text-sm">
                {notes[e.n].map((note) => (
                  <li key={`${note.range}|${note.note}`} className="flex min-w-0 gap-2">
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{note.range}</span>
                    <span className="min-w-0 break-words">{note.note}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>

      {first === "failed" && <p className="text-sm">1편을 쓰지 못했어요. 대화 홈에서 [다시 쓰기]를 눌러 주세요.</p>}
      {first === "refused" && <p className="text-sm">AI가 이 대화로는 연재를 쓰지 않았어요. 이번 달 횟수는 줄지 않아요.</p>}
      {first === "safety" && <p className="text-sm">{SAFETY_HELP}</p>}

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
