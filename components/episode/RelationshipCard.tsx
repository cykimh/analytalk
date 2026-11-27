// 관계 카드(v2.9): 마무리 부분 앞에 놓는 한 장(AI가 쓴 것, 검증을 거친 칸만). 섹션 카드와 같은 모양(아이콘 칩 + 형광펜 h2)이다.
// 순서: 관계 한 줄 → 서로에게(단톡은 이 방이 각자에게) → 내부 농담 → 부딪히는 법과 푸는 법. 빈 칸은 그리지 않는다
import { Highlight } from "@/components/scrap/Highlight";
import { Paper } from "@/components/scrap/Paper";
import { Sticker } from "@/components/scrap/Sticker";
import type { HighlightColor } from "@/components/scrap/tilt";
import type { StoredRelationship } from "@/lib/llm/schema";
import type { ChatStats } from "@/lib/stats/compute";
import { StatText } from "./StatText";

export function RelationshipCard({ relationship: r, stats, pair, color }: { relationship: StoredRelationship; stats: ChatStats; pair: boolean; color: HighlightColor }) {
  const blocks: [string, string][] = [
    [pair ? "서로에게" : "이 방이 각자에게", r.to_each_other],
    ["부딪히는 법과 푸는 법", r.conflict],
  ].filter((x): x is [string, string] => x[1] !== "");
  return (
    <Paper as="section" aria-labelledby="report-relationship" className="grid grid-cols-1 gap-4 px-5 pt-7 pb-6">
      <h2 id="report-relationship" className="flex min-w-0 items-start gap-2 text-[1.25rem] leading-tight font-bold wrap-anywhere tracking-tight">
        <Sticker aria-hidden className="mt-0.5 shrink-0 px-1.5 font-sans text-lg leading-none">
          🤝
        </Sticker>
        <span className="min-w-0">
          <Highlight color={color}>{pair ? "두 사람의 관계" : "이 방의 관계"}</Highlight>
        </span>
      </h2>
      {r.one_line && (
        <p className="text-[1.125rem] leading-relaxed font-bold wrap-anywhere">
          <StatText text={r.one_line} stats={stats} />
        </p>
      )}
      {blocks.length > 0 && (
        <dl className="grid min-w-0 grid-cols-1 gap-3">
          {blocks.map(([label, text]) => (
            <div key={label} className="grid min-w-0 gap-0.5">
              <dt className="text-[0.875rem] font-bold text-ink-soft">{label}</dt>
              <dd className="text-[1.0625rem] leading-[1.8] wrap-anywhere">
                <StatText text={text} stats={stats} />
              </dd>
            </div>
          ))}
        </dl>
      )}
      {r.inside_jokes.length > 0 && (
        <div className="grid min-w-0 gap-1.5">
          <p className="text-[0.875rem] font-bold text-ink-soft">내부 농담</p>
          <ul className="grid list-disc gap-1 pl-5 text-base leading-relaxed">
            {r.inside_jokes.map((j) => (
              <li key={j} className="wrap-anywhere">
                <StatText text={j} stats={stats} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </Paper>
  );
}
