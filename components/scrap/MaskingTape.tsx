// 마스킹 테이프 한 조각(장식). 카드(Paper) 위쪽 가운데나 모서리에 붙는다. 읽어 주지 않는다
import { cn } from "@/lib/utils";
import type { TapeAt, TapeColor, TapeSpec } from "./tilt";

// 모서리 테이프는 가늘고 짧게, 모서리 바깥으로 비껴 붙여 카드 첫 줄 글자를 덮지 않는다
const PLACE: Record<TapeAt, string> = {
  center: "-top-3 left-1/2 w-24 -translate-x-1/2 -rotate-2",
  left: "-top-2.5 -left-4 h-5 w-14 -rotate-[36deg]",
  right: "-top-2.5 -right-4 h-5 w-14 rotate-[34deg]",
};

const COLOR: Record<TapeColor, string> = {
  pink: "bg-tape-pink",
  sky: "bg-tape-sky",
  lime: "bg-tape-lime",
  lilac: "bg-tape-lilac",
  butter: "bg-tape-butter",
};

export function MaskingTape({ color, at }: TapeSpec) {
  return <span aria-hidden className={cn("tape", PLACE[at], COLOR[color])} />;
}
