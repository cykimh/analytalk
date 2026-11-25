// 편 화면의 문단 [틀렸어요] 모음. 리포트 영역(#report-capture) 바깥 아래에 둔다(DESIGN.md).
// 문단마다 앞부분을 보여 주고 버튼 설명(aria-describedby)으로 묶는다. 보내는 것은 FeedbackButton 그대로다(문단 글은 보내지 않는다)
import { Paper } from "@/components/scrap/Paper";
import { paragraphRef } from "@/lib/episode/feedback";
import type { StoredEpisode } from "@/lib/llm/schema";
import type { ChatStats } from "@/lib/stats/compute";
import { FeedbackButton } from "./FeedbackButton";
import { StatText } from "./StatText";

export function ParagraphFeedback({ id, n, content, stats }: { id: string; n: number; content: StoredEpisode; stats: ChatStats }) {
  const rows = content.sections.flatMap((s, si) => s.paragraphs.map((p) => ({ ref: paragraphRef(si, p.key), text: p.text })));
  if (rows.length === 0) return null;
  return (
    <Paper as="section" aria-labelledby="feedback-title" className="grid grid-cols-1 gap-3">
      <p id="feedback-title" className="font-hand text-xl font-bold">
        틀린 문단이 있으면 알려 주세요
      </p>
      <ol className="grid grid-cols-1">
        {rows.map((r) => (
          <li key={r.ref} className="grid grid-cols-1 gap-1 border-t border-dashed border-ink/15 py-3 first:border-t-0 first:pt-0 last:pb-0">
            <p id={`feedback-${r.ref}`} className="line-clamp-2 text-base text-ink-soft wrap-anywhere">
              <StatText text={r.text} stats={stats} />
            </p>
            <FeedbackButton id={id} n={n} paragraphKey={r.ref} describedBy={`feedback-${r.ref}`} />
          </li>
        ))}
      </ol>
    </Paper>
  );
}
