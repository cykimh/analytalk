import { describe, expect, it } from "vitest";
import {
  alternate,
  CALM_TILT_CLASS,
  degreesOf,
  highlightAt,
  noteTiltAt,
  polaroidTiltAt,
  stickerTiltAt,
  TAPE_COLORS,
  tapeAt,
  TILT_CLASS,
} from "./tilt";

describe("콜라주 기울기", () => {
  it("카드·긴 본문 카드는 기울이지 않는다(장식 줄임)", () => {
    expect(degreesOf(TILT_CLASS.left)).toBe(0);
    expect(degreesOf(TILT_CLASS.right)).toBe(0);
    expect(degreesOf(TILT_CLASS.none)).toBe(0);
    for (const c of Object.values(CALM_TILT_CLASS)) expect(degreesOf(c)).toBe(0);
  });

  it("왼쪽부터 번갈아 기운다", () => {
    expect([0, 1, 2, 3].map(alternate)).toEqual(["left", "right", "left", "right"]);
  });

  it("스티커·폴라로이드·인용은 기울이지 않는다", () => {
    for (let i = 0; i < 12; i++) {
      for (const c of [stickerTiltAt(i), polaroidTiltAt(i), noteTiltAt(i)]) expect(degreesOf(c)).toBe(0);
    }
  });

  it("degreesOf는 기울기 클래스가 아니면 던진다", () => {
    expect(() => degreesOf("rotate-x-2")).toThrow();
  });
});

describe("테이프·형광펜", () => {
  it("테이프 색은 다섯 가지를, 자리는 가운데·왼쪽·오른쪽을 돌아가며 쓴다(이웃한 카드는 둘 다 같지 않다)", () => {
    expect(new Set(Array.from({ length: 15 }, (_, i) => tapeAt(i).color))).toEqual(new Set(TAPE_COLORS));
    expect([0, 1, 2, 3].map((i) => tapeAt(i).at)).toEqual(["center", "left", "right", "center"]);
    for (let i = 0; i < 20; i++) {
      expect(tapeAt(i).color).not.toBe(tapeAt(i + 1).color);
      expect(tapeAt(i).at).not.toBe(tapeAt(i + 1).at);
    }
  });

  it("형광펜은 노랑부터 민트와 번갈아", () => {
    expect([0, 1, 2].map(highlightAt)).toEqual(["yellow", "mint", "yellow"]);
  });
});
