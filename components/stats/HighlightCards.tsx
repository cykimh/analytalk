// 리포트 맨 위 '하이라이트 한 줄 카드'(v2.8): 표지 폴라로이드 아래에 흰 카드를 한 줄씩 쌓는다(2열 타일 벽은 쓰지 않는다).
// 카드는 lib/stats/highlights가 통계로 고른다(케미 온도만 AI가 매긴 값). 읽는 순서는 이름표(dt) → 숫자(dd) → 한 줄.
// 케미 온도의 한 줄은 모델이 쓴 글이라 StatText(React 텍스트 노드)로 그린다. 훅이 없어 서버·클라이언트 어디서나 쓴다
import { StatText } from "@/components/episode/StatText";
import type { HighlightCard } from "@/lib/stats/highlights";
import type { ChatStats } from "@/lib/stats/compute";

export function HighlightCards({ cards, stats }: { cards: HighlightCard[]; stats: ChatStats }) {
  if (cards.length === 0) return null;
  return (
    <section aria-labelledby="report-highlights" className="grid min-w-0 grid-cols-1 gap-3">
      <p id="report-highlights" className="flex items-center gap-3 px-1 text-[0.875rem] font-bold text-ink-soft">
        한 줄 하이라이트
        <span aria-hidden className="h-px flex-1 bg-ink/15" />
      </p>
      <dl className="grid min-w-0 grid-cols-1 gap-2">
        {cards.map((c) => (
          // 이모지는 이름표 앞 장식(aria-hidden), 숫자·한 줄은 이름표 글자 줄에 맞춰 들여 쓴다
          <div key={c.key} className="paper-sheet grid min-w-0 grid-cols-1 gap-0.5 bg-sheet px-4 py-3">
            <dt className="flex min-w-0 items-center gap-2 text-base leading-snug text-ink-soft">
              <span aria-hidden className="w-5 shrink-0 text-center text-[1.125rem] leading-none">
                {c.emoji}
              </span>
              <span className="min-w-0 wrap-anywhere">{c.label}</span>
            </dt>
            <dd className="pl-7 text-[1.125rem] leading-snug font-bold tabular-nums wrap-anywhere">{c.value}</dd>
            {c.note && (
              <dd className="pt-1 pl-7 text-base leading-relaxed wrap-anywhere">
                <StatText text={c.note} stats={stats} />
              </dd>
            )}
          </div>
        ))}
      </dl>
    </section>
  );
}
