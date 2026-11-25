// 근거 인용: 찢은 메모지에 표시 이름 · 시각(KST) → 인용. 인용은 검증을 통과한 글자 그대로이고 React 텍스트 노드로만 그린다
import { TornNote } from "@/components/scrap/TornNote";
import { formatAt } from "./model";

export function Evidence({ sender, at, quote, index = 0 }: { sender: string; at: string; quote: string; index?: number }) {
  return (
    <TornNote index={index}>
      <figcaption className="text-[0.8125rem] leading-5 text-ink-soft">
        <span className="font-bold text-ink">{sender}</span> · <span className="tabular-nums">{formatAt(at)}</span>
      </figcaption>
      <blockquote className="text-base leading-7 break-words whitespace-pre-wrap">{quote}</blockquote>
    </TornNote>
  );
}
