import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateCostUsd, type Usage } from "./cost";

const usage = (u: Partial<Usage>): Usage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  ...u,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("estimateCostUsd", () => {
  it("Opus 5.5: cache write 128K + output 7K → 약 $0.78", () => {
    const cost = estimateCostUsd(usage({ cache_creation_input_tokens: 128_000, output_tokens: 7_000 }), "claude-opus-5-5");
    expect(cost).toBeCloseTo(0.78, 2);
    expect(Math.abs(cost - 0.78)).toBeLessThanOrEqual(0.01);
  });

  it("단가표: Opus 5.5 4/20/5/0.20, Sonnet 5.5 2/10/2.5/0.10, Opus 5·4.8 5/25/6.25/0.50 ($/MTok)", () => {
    const m = usage({ input_tokens: 1e6, output_tokens: 1e6, cache_creation_input_tokens: 1e6, cache_read_input_tokens: 1e6 });
    expect(estimateCostUsd(m, "claude-opus-5-5")).toBeCloseTo(4 + 20 + 5 + 0.2, 6);
    expect(estimateCostUsd(m, "claude-sonnet-5-5")).toBeCloseTo(2 + 10 + 2.5 + 0.1, 6);
    expect(estimateCostUsd(m, "claude-opus-5")).toBeCloseTo(5 + 25 + 6.25 + 0.5, 6);
    expect(estimateCostUsd(m, "claude-opus-4-8")).toBeCloseTo(5 + 25 + 6.25 + 0.5, 6);
    // 날짜가 붙은 스냅샷 id도 같은 단가
    expect(estimateCostUsd(m, "claude-opus-5-5-20261101")).toBeCloseTo(29.2, 6);
  });

  it("2~4편 캐시 읽기는 0.1배 단가", () => {
    const cost = estimateCostUsd(usage({ cache_read_input_tokens: 128_000, input_tokens: 500, output_tokens: 7_000 }), "claude-opus-5-5");
    expect(cost).toBeCloseTo(128_000 * 0.2e-6 + 500 * 4e-6 + 7_000 * 20e-6, 9);
  });

  it("iterations(거절 1 + fallback 1)가 있으면 항목별 모델 단가로 합산한다", () => {
    const declined = { type: "message", model: "claude-opus-5-5", input_tokens: 100, output_tokens: 1_000, cache_creation_input_tokens: 128_000, cache_read_input_tokens: 0 };
    const fallback = { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 128_100, output_tokens: 6_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    const top = usage({ input_tokens: 128_100, output_tokens: 6_000, iterations: [declined, fallback] });
    const expected =
      estimateCostUsd(usage({ input_tokens: 100, output_tokens: 1_000, cache_creation_input_tokens: 128_000 }), "claude-opus-5-5") +
      estimateCostUsd(usage({ input_tokens: 128_100, output_tokens: 6_000 }), "claude-opus-4-8");
    // 넘긴 model과 top-level 값은 쓰지 않는다
    expect(estimateCostUsd(top, "claude-sonnet-5-5")).toBeCloseTo(expected, 9);
  });

  it("iterations 항목의 캐시 필드가 없으면 0으로 센다", () => {
    const it1 = { type: "message", model: "claude-sonnet-5-5", input_tokens: 1e6, output_tokens: 0 };
    expect(estimateCostUsd(usage({ iterations: [it1] }), "claude-opus-5-5")).toBeCloseTo(2, 9);
  });

  it("표에 없는 모델은 기본(Opus 5) 단가로 계산하고 경고를 남긴다", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cost = estimateCostUsd(usage({ output_tokens: 1e6 }), "claude-haiku-9");
    expect(cost).toBeCloseTo(25, 9);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("claude-haiku-9");
  });

  it("claude-sonnet-5는 캐시 읽기 $0.2, 5-5는 $0.1 (5-5가 Sonnet 5 행에 잡히지 않는다)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(estimateCostUsd(usage({ input_tokens: 1e6 }), "claude-sonnet-5")).toBeCloseTo(2, 9);
    expect(estimateCostUsd(usage({ cache_read_input_tokens: 1e6 }), "claude-sonnet-5")).toBeCloseTo(0.2, 9);
    expect(estimateCostUsd(usage({ cache_read_input_tokens: 1e6 }), "claude-sonnet-5-5")).toBeCloseTo(0.1, 9);
    expect(warn).not.toHaveBeenCalled();
  });
});
