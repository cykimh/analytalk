// 근거 말풍선: 표시 이름 · 시각(KST) → 인용. 인용은 검증을 통과한 글자 그대로이고 React 텍스트 노드로만 그린다
import { formatAt } from "./model";

export function Evidence({ sender, at, quote }: { sender: string; at: string; quote: string }) {
  return (
    <figure className="grid w-fit max-w-[85%] min-w-0 gap-1 rounded-2xl rounded-tl-sm border bg-muted/60 px-3 py-2">
      <figcaption className="text-xs text-muted-foreground">
        {sender} · {formatAt(at)}
      </figcaption>
      <blockquote className="text-sm break-words whitespace-pre-wrap">{quote}</blockquote>
    </figure>
  );
}
