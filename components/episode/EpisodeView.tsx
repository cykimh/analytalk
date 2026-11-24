// 편 한 편: 헤드라인 → dek → 섹션(아이콘·제목·문단 → 근거 말풍선) → 다음 편 예고. 'AI 생성, 재미·참고용'을 단다.
// 모든 글은 React 텍스트 노드로만 그린다. 숫자는 {{stat:경로}}를 renderStatText로 채운다.
// feedback이 있으면(대화 주인) 문단마다 [틀렸어요]를 단다. 공유 화면은 feedback 없이 쓴다
import { Fragment } from "react";
import { paragraphRef } from "@/lib/episode/feedback";
import { renderStatText } from "@/lib/episode/statText";
import type { StoredEpisode } from "@/lib/llm/schema";
import type { ChatStats } from "@/lib/stats/compute";
import { Evidence } from "./Evidence";
import { FeedbackButton } from "./FeedbackButton";
import { AI_NOTICE } from "./model";

function StatText({ text, stats }: { text: string; stats: ChatStats }) {
  return renderStatText(text, stats).map((t, i) =>
    typeof t === "string" ? (
      <Fragment key={i}>{t}</Fragment>
    ) : (
      <strong key={i} className="font-semibold tabular-nums">
        {t.display}
      </strong>
    ),
  );
}

export function EpisodeView({
  n,
  content,
  stats,
  feedback,
}: {
  n: number;
  content: StoredEpisode;
  stats: ChatStats;
  feedback?: { id: string };
}) {
  return (
    <article className="grid min-w-0 gap-8">
      <header className="grid gap-2">
        <p className="text-xs text-muted-foreground">
          {n}편 · {AI_NOTICE}
        </p>
        <h1 className="text-2xl leading-snug font-semibold break-words">{content.headline || `${n}편`}</h1>
        {content.dek && <p className="text-muted-foreground break-words">{content.dek}</p>}
      </header>

      {content.sections.map((section, si) => (
        <section key={`${si}-${section.title}`} className="grid min-w-0 gap-3">
          <h2 className="text-lg font-semibold break-words">
            <span aria-hidden className="mr-1.5">
              {section.icon}
            </span>
            {section.title}
          </h2>
          {section.paragraphs.map((p, pi) => (
            <div key={`${pi}-${p.key}`} className="grid gap-1">
              <p className="leading-relaxed break-words">
                <StatText text={p.text} stats={stats} />
              </p>
              {feedback && <FeedbackButton id={feedback.id} n={n} paragraphKey={paragraphRef(si, p.key)} />}
            </div>
          ))}
          {section.evidence.length > 0 && (
            <div className="grid gap-2">
              {section.evidence.map((e) => (
                <Evidence key={e.id} sender={e.sender} at={e.at} quote={e.quote} />
              ))}
            </div>
          )}
        </section>
      ))}

      {content.next_teaser && (
        <footer className="grid gap-1 rounded-xl bg-muted p-4 text-sm">
          <span className="text-xs text-muted-foreground">다음 편 예고</span>
          <p className="break-words">{content.next_teaser}</p>
        </footer>
      )}
    </article>
  );
}
