// 칩(멤버 이름·컨셉·기간·섹션 아이콘): 옅은 종이색 바탕 + 1px 선, 둥근 모서리, 기울이지 않는다(2026-11-25 장식 줄임).
// tone을 주면 그 색을 쓰고, 없으면 한 가지 색이다(색이 제각각인 스티커는 쓰지 않는다). 긴 이름은 한 줄에서 말줄임
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { type StickerTone, stickerTiltAt } from "./tilt";

const TONE: Record<StickerTone, string> = {
  butter: "bg-sticker-butter",
  pink: "bg-sticker-pink",
  mint: "bg-sticker-mint",
  sky: "bg-sticker-sky",
  lilac: "bg-sticker-lilac",
  kraft: "bg-sticker-kraft",
};

export function Sticker({
  index = 0,
  tone,
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { index?: number; tone?: StickerTone }) {
  return (
    <span className={cn("sticker text-[0.9375rem]", tone ? TONE[tone] : "bg-paper", stickerTiltAt(index), className)} {...rest}>
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}
