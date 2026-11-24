// 호출 한 번의 추정 원가(USD). 사용량 원장과 주간 차단에 쓴다.

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  /** 서버 측 fallback이면 시도마다 한 항목(거절한 시도 포함). 있으면 이것으로 계산한다 */
  iterations?: {
    type: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  }[];
}

/** $/MTok. 캐시 쓰기는 5분 TTL(입력 1.25배), 읽기는 0.1배 */
interface Price {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const OPUS_5_5: Price = { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 };
const SONNET_5_5: Price = { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 };
/** Opus 5·Opus 4.8, 그리고 표에 없는 모델 */
const DEFAULT_PRICE: Price = { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 };

// 긴 id부터 본다: claude-opus-5는 claude-opus-5-5의 앞부분이다
const PRICES: [string, Price][] = [
  ["claude-opus-5-5", OPUS_5_5],
  ["claude-sonnet-5-5", SONNET_5_5],
  ["claude-opus-5", DEFAULT_PRICE],
  ["claude-opus-4-8", DEFAULT_PRICE],
];

/** 별칭이나 날짜가 붙은 스냅샷 id(claude-opus-5-5-20261101)도 같은 단가 */
function priceOf(model: string): Price {
  const hit = PRICES.find(([id]) => model === id || model.startsWith(`${id}-`));
  if (hit) return hit[1];
  console.warn(`[cost] 단가표에 없는 모델 ${model}: 기본 단가(Opus 5)로 계산한다`);
  return DEFAULT_PRICE;
}

export function estimateCostUsd(usage: Usage, model: string): number {
  const items = usage.iterations?.length ? usage.iterations : [{ ...usage, model }];
  let total = 0;
  for (const it of items) {
    const p = priceOf(it.model);
    total +=
      it.input_tokens * p.input +
      it.output_tokens * p.output +
      (it.cache_creation_input_tokens ?? 0) * p.cacheWrite +
      (it.cache_read_input_tokens ?? 0) * p.cacheRead;
  }
  return total / 1_000_000;
}
