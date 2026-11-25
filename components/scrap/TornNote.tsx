// 근거 인용 메모: 옅은 종이색 바탕, 왼쪽 3px 선, 왼쪽 위 큰 따옴표(2026-11-25 장식 줄임: 찢은 가장자리·줄 무늬·그림자 없음).
// children은 figcaption·blockquote다(figcaption은 figure의 첫 자식이어야 해서 그림자는 바깥 div가 그린다).
// figure는 grid-cols-1(minmax(0,1fr)): 긴 인용 한 단어가 칸을 넓혀 w-fit 메모지가 카드 밖으로 커지지 않게 한다
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { noteTiltAt } from "./tilt";

export function TornNote({ index = 0, children, className }: { index?: number; children: ReactNode; className?: string }) {
  return (
    <div className={cn("torn-shadow w-fit max-w-[94%] min-w-0", noteTiltAt(index), className)}>
      <figure className="torn relative grid min-w-0 grid-cols-1 gap-1 py-3 pr-4 pl-9">{children}</figure>
    </div>
  );
}
