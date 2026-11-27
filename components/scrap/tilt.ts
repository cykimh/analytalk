// 콜라주 조각이 순서대로 돌려 쓰는 값: 카드 기울기·테이프 색과 자리·형광펜 색·스티커 색과 기울기. DOM 없이 테스트한다.
// Tailwind가 소스에서 클래스 이름을 읽으므로 클래스는 늘 완성된 글자로 둔다(조립하지 않는다)

export type Tilt = "left" | "right" | "none";

/** 카드 기울기. 2026-11-25 "장식 줄여줘"로 기울이지 않는다(left·right도 0°). 다시 기울이려면 여기만 바꾼다 */
export const TILT_CLASS: Record<Tilt, string> = { left: "", right: "", none: "" };
/** 긴 본문이 든 카드(지금은 TILT_CLASS와 같이 0°) */
export const CALM_TILT_CLASS: Record<Tilt, string> = { left: "", right: "", none: "" };

/** i번째(0부터) 카드의 기울기. 왼쪽부터 번갈아 */
export const alternate = (i: number): Tilt => (i % 2 === 0 ? "left" : "right");

export const TAPE_COLORS = ["pink", "sky", "lime", "lilac", "butter"] as const;
export type TapeColor = (typeof TAPE_COLORS)[number];
export type TapeAt = "center" | "left" | "right";
export interface TapeSpec {
  color: TapeColor;
  at: TapeAt;
}

const TAPE_PLACES: readonly TapeAt[] = ["center", "left", "right"];

/** i번째 카드의 테이프: 색 다섯 가지와 자리(가운데·왼쪽 모서리·오른쪽 모서리)를 서로 다른 주기로 돌린다 */
export const tapeAt = (i: number): TapeSpec => ({
  color: TAPE_COLORS[i % TAPE_COLORS.length],
  at: TAPE_PLACES[i % TAPE_PLACES.length],
});

export type HighlightColor = "yellow" | "mint";
/** i번째 제목의 형광펜 색. 노랑부터 번갈아 */
export const highlightAt = (i: number): HighlightColor => (i % 2 === 0 ? "yellow" : "mint");

export const STICKER_TONES = ["butter", "pink", "mint", "sky", "lilac", "kraft"] as const;
export type StickerTone = (typeof STICKER_TONES)[number];
export const stickerToneAt = (i: number): StickerTone => STICKER_TONES[i % STICKER_TONES.length];

/** 스티커 기울기(지금은 0°) */
const STICKER_TILTS = [""] as const;
export const stickerTiltAt = (i: number): string => STICKER_TILTS[i % STICKER_TILTS.length];

/** 폴라로이드 기울기(지금은 0°) */
const POLAROID_TILTS = [""] as const;
export const polaroidTiltAt = (i: number): string => POLAROID_TILTS[i % POLAROID_TILTS.length];

/** 클래스 글자에서 기울기(도)를 읽는다. 테스트가 "긴 본문 카드 ±0.5° 이하"를 확인하는 데 쓴다 */
export function degreesOf(className: string): number {
  if (className === "") return 0;
  const m = /^(-?)rotate-(?:\[(-?[\d.]+)deg\]|(\d+))$/.exec(className);
  if (!m) throw new Error(`기울기 클래스가 아니다: ${className}`);
  const value = Number(m[2] ?? m[3]);
  return m[1] === "-" ? -value : value;
}
