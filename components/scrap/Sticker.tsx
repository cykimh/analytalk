// 다이컷 종이 스티커(흰 테두리 + 둥근 모서리, 살짝 기울임): 멤버 이름·컨셉·기간·섹션 아이콘.
// 색과 기울기는 index로 돌려 고른다(stickerToneAt·stickerTiltAt). 긴 이름은 한 줄에서 말줄임
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { type StickerTone, stickerTiltAt, stickerToneAt } from "./tilt";

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
    <span className={cn("sticker text-[1.0625rem]", TONE[tone ?? stickerToneAt(index)], stickerTiltAt(index), className)} {...rest}>
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}
