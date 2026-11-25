// 형광펜: 제목 글자 뒤 아래쪽 절반에 칠한 단색 띠. 색은 highlightAt(i)로 섹션마다 번갈아 고른다
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { HighlightColor } from "./tilt";

export function Highlight({ color = "yellow", children }: { color?: HighlightColor; children: ReactNode }) {
  return <span className={cn("hl", color === "mint" && "hl-mint")}>{children}</span>;
}
