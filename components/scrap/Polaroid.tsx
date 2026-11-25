// 폴라로이드 한 장: 흰 테두리, 두꺼운 아래 여백에 캡션, 사진 칸에 숫자(tabular).
// <dl> 안에 둔다(PolaroidStrip). 읽는 순서는 캡션(dt) → 숫자(dd)이고, 화면에는 숫자가 위·캡션이 아래다
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { polaroidTiltAt, type StickerTone } from "./tilt";

const PHOTO: Record<StickerTone, string> = {
  butter: "bg-sticker-butter",
  pink: "bg-sticker-pink",
  mint: "bg-sticker-mint",
  sky: "bg-sticker-sky",
  lilac: "bg-sticker-lilac",
  kraft: "bg-sticker-kraft",
};

export function PolaroidStrip({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn("grid grid-cols-3 items-start gap-2.5 px-1", className)}>{children}</dl>;
}

export function Polaroid({
  caption,
  value,
  unit,
  sub,
  tone = "butter",
  index = 0,
}: {
  caption: string;
  value: string;
  unit?: string;
  sub?: string;
  tone?: StickerTone;
  index?: number;
}) {
  return (
    <div className={cn("polaroid flex min-w-0 flex-col", polaroidTiltAt(index))}>
      <dt className="order-2 grid min-h-11 place-items-center px-0.5 py-1.5 text-center text-base leading-tight font-bold text-balance">
        {caption}
      </dt>
      <dd className={cn("polaroid-photo @container order-1 grid aspect-square min-w-0 content-center justify-items-center gap-1 px-1", PHOTO[tone])}>
        {/* 사진 칸 너비(cqi)에 맞춰 숫자 크기를 정한다. 긴 숫자(15,234)는 한 단계 작게 */}
        <span
          className={cn(
            "max-w-full truncate leading-none font-bold tabular-nums",
            value.length <= 4 ? "text-[clamp(1.375rem,30cqi,2.25rem)]" : "text-[clamp(1.125rem,21cqi,1.75rem)]",
          )}
        >
          {value}
          {unit && <span className="ml-0.5 text-[0.55em]">{unit}</span>}
        </span>
        {sub && <span className="max-w-full truncate text-xs text-ink-soft tabular-nums">{sub}</span>}
      </dd>
    </div>
  );
}
