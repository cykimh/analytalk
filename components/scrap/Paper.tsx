// 모눈종이 위에 붙인 종이 한 장. 기울기(tilt)·테이프(tape)는 tilt.ts의 순서 함수로 고른다.
// 긴 본문이 든 카드는 calm으로 ±0.5° 이하만 기운다. 애니메이션은 넣지 않는다(정적 기울기만)
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { MaskingTape } from "./MaskingTape";
import { CALM_TILT_CLASS, TILT_CLASS, type TapeSpec, type Tilt } from "./tilt";

type PaperTag = "div" | "section" | "header" | "footer" | "li" | "aside";

/** 종이 바탕: 흰 종이, 노란 메모지, 크라프트지 */
export type PaperTone = "sheet" | "butter" | "kraft";

const TONE: Record<PaperTone, string> = {
  sheet: "bg-sheet",
  butter: "bg-sticker-butter",
  kraft: "bg-sticker-kraft",
};

export function Paper({
  as: Tag = "div",
  tilt = "none",
  calm = false,
  tape,
  tone = "sheet",
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLElement> & { as?: PaperTag; tilt?: Tilt; calm?: boolean; tape?: TapeSpec; tone?: PaperTone }) {
  return (
    <Tag className={cn("paper-sheet relative min-w-0 p-4 text-ink", TONE[tone], (calm ? CALM_TILT_CLASS : TILT_CLASS)[tilt], className)} {...rest}>
      {tape && <MaskingTape {...tape} />}
      {children}
    </Tag>
  );
}
