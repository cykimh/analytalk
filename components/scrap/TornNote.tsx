// 찢은 메모지(근거 인용). 위아래가 들쭉날쭉한 종이에 옅은 줄, 왼쪽 위에 손글씨 따옴표.
// children은 figcaption·blockquote다(figcaption은 figure의 첫 자식이어야 해서 그림자는 바깥 div가 그린다)
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { noteTiltAt } from "./tilt";

export function TornNote({ index = 0, children, className }: { index?: number; children: ReactNode; className?: string }) {
  return (
    <div className={cn("torn-shadow w-fit max-w-[94%] min-w-0", noteTiltAt(index), className)}>
      <figure className="torn lined relative grid min-w-0 gap-1 py-3 pr-4 pl-9">{children}</figure>
    </div>
  );
}
