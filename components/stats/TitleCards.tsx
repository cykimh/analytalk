// '누가 더 ___?' 칭호 카드(v2.9): 하이라이트 아래, 흰 카드 한 장에 칭호를 한 줄씩(구분선) 쌓는다. 칭호는 lib/stats/titles가 통계로 정한다.
// 읽는 순서는 칭호·기준(dt) → 1위와 값(dd). 이모지는 장식(aria-hidden). 훅이 없어 서버·클라이언트 어디서나 쓴다
import type { TitleCard } from "@/lib/stats/titles";

export function TitleCards({ cards }: { cards: TitleCard[] }) {
  if (cards.length === 0) return null;
  return (
    <section aria-labelledby="report-titles" className="grid min-w-0 grid-cols-1 gap-3">
      <p id="report-titles" className="flex items-center gap-3 px-1 text-[0.875rem] font-bold text-ink-soft">
        누가 더 ___?
        <span aria-hidden className="h-px flex-1 bg-ink/15" />
      </p>
      <dl className="paper-sheet grid min-w-0 grid-cols-1 bg-sheet px-4 py-1">
        {cards.map((c) => (
          <div key={c.key} className="grid min-w-0 grid-cols-1 gap-0.5 border-t border-ink/10 py-3 first:border-t-0">
            <dt className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <span aria-hidden className="w-5 shrink-0 text-center text-[1.125rem] leading-none">
                {c.emoji}
              </span>
              <span className="text-base font-bold">{c.title}</span>
              <span className="text-[0.875rem] text-ink-soft">{c.desc}</span>
            </dt>
            <dd className="pl-7 text-[1.0625rem] leading-snug font-bold tabular-nums wrap-anywhere">{c.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
