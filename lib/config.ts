// PRD 확정 수치. 값을 바꾸면 PRD도 함께 고친다.

// 편 생성 (서버)
export const EPISODE_DEADLINE_MS = 270_000; // 편당 마감 (maxDuration = 300)
/**
 * 페이로드 JSON 상한 4MB. Vercel 함수의 요청 본문 한도 4.5MB(4,500,000바이트로 어림) 안에 들어가는지 셈:
 * - 요청 본문은 페이로드 JSON(POST /api/conversations) 또는 { id, payload }(다시 쓰기, id 64자 이하)라 페이로드 밖 몫은 100바이트 안팎이다
 * - Sonnet 입력 예산 700,000토큰 × TOKENS_PER_CHAR 1.0 → 대화 본문은 70만 자 이하(프롬프트·통계·범례 몫을 빼면 더 적다).
 *   한글은 UTF-8로 글자당 3바이트(서로게이트 쌍 이모지는 UTF-16 2자에 4바이트)라 본문은 2.1MB 이하
 * - 전체 stats JSON(날짜별 수·달별·사람별 표)은 몇 년 치 단톡방도 수백 KB라, 페이로드는 보통 2.5MB 안쪽이다
 * - buildPayloadForBudget은 본문 글자 수를 (4MB × 0.9 − stats 바이트) ÷ 3으로도 묶어, 예산을 더 올려도 페이로드가 약 3.6MB를 넘지 않는다
 * 그래서 4MB를 그대로 두고 4.5MB까지 약 0.5MB(JSON 이스케이프·요청의 다른 필드) 여유를 둔다. 4.5MB에 가깝게 올리지 않는다
 */
export const MAX_PAYLOAD_BYTES = 4_000_000;
export const TOKENS_PER_CHAR = 1.0;
/** 모델별 입력 예산(토큰). 표 밖의 모델은 FALLBACK. 서버의 INPUT_TOKEN_BUDGET env가 이 값을 덮어쓴다 */
export const INPUT_TOKEN_BUDGET_BY_MODEL: readonly (readonly [string, number])[] = [
  ["claude-sonnet-5-5", 700_000],
  ["claude-opus-5-5", 128_000],
];
export const FALLBACK_INPUT_TOKEN_BUDGET = 128_000;
/** 날짜가 붙은 스냅샷 id도 같은 모델로 본다(lib/llm/cost.ts priceOf와 같은 규칙) */
export function inputTokenBudgetFor(model: string): number {
  const hit = INPUT_TOKEN_BUDGET_BY_MODEL.find(([id]) => model === id || model.startsWith(`${id}-`));
  return hit ? hit[1] : FALLBACK_INPUT_TOKEN_BUDGET;
}
export const PROMPT_RESERVE_TOKENS = 9500; // system 프롬프트·리포트 지시 몫(토큰 어림, v2.2 말투별 구성으로 6000 → 7000, v2.3 문단 길이 예시로 7000 → 8000, v2.4 판정 지시·세 부분 구성으로 8000 → 9000, v2.7 묶음 줄·접은 표시 데이터 계약으로 9000 → 9500). 정확한 값은 countTokens로 확인한다

// 모델에게 보여 주는 통계 요약(statsForPrompt). 서버의 자리표시자 해석은 전체 stats를 쓴다
export const PROMPT_STATS_MAX_PEOPLE = 12;
export const PROMPT_STATS_MAX_MONTHS = 24;
export const PROMPT_STATS_MAX_CROSSED = 20;

// 보관·한도·예산
export const RETENTION_DAYS = 30;
export const DEFAULT_MONTHLY_LIMIT = 2; // 초대 코드 기본 월 한도(건)
export const WEEKLY_CAP_USD = 22.5; // 전역 주간 차단
export const MONTHLY_BUDGET_USD = 90;
/**
 * 건당 추정 원가(대화 한 건 = 리포트 한 번). v2.5 나눠 쓰기(호출 3~4개, Sonnet 5.5, 입력 48만 토큰) 어림:
 * 캐시 쓰기 48만 × $2.5/MTok ≈ $1.2 + 캐시 읽기 2~3회 × 48만 × $0.10/MTok ≈ $0.1~0.15 + 출력 합 약 4.5만 × $10/MTok ≈ $0.45 → 약 $1.8.
 * v2.4까지 한 번 호출은 $1.2(실측 3: $1.03). 실측 뒤 보정
 */
export const DEFAULT_EST_COST_USD = 2.2;
export const MAX_REPORT_RUNS = 3; // 리포트의 유료 실행 상한(처음 1번 + [다시 쓰기] 2번). 넘으면 retry가 429 retry_limit
export const CYCLE_ANCHOR_DAY = 1; // 크레딧 주기 기준일(서울 00:00 시작). settings.cycle_anchor_day 기본값과 같다

// 검증
export const MAX_QUOTES_PER_REPORT = 30; // 리포트 전체 근거 인용 상한(v2.2: 섹션 최대 10개 × 섹션당 최대 3개라 16 → 30. 분량 단계별 목표는 lib/llm/prompt.ts VOLUMES)
export const PARTIAL_DROP_RATIO = 0.3; // 문단 30% 이상 삭제되면 partial
export const RECOGNITION_WARN = 0.98; // 줄 인식률 경고 기준
export const NOTE_MAX_CHARS = 60;
export const MAX_READING_NOTES = 20; // 저장·표시하는 reading_notes 개수 상한

// 보낼 메시지 고르기(대화 전체가 buildPayload tokenBudget에 안 들어갈 때). 몫은 tokenBudget에 대한 비율이다
export const SAMPLE_TAIL_SHARE = 0.2; // 마지막 메시지까지 이어지는 최근 구간. 다 고르고 남은 몫도 여기에 더한다
export const SAMPLE_BUSY_SHARE = 0.1; // 가장 활발했던 날들(그날 첫 메시지부터). 다 담고 남으면 달 몫으로 간다
export const SAMPLE_BUSY_DAYS = 3;
export const SAMPLE_CHUNKS_PER_MONTH = 3; // 달 몫을 나눌 연속 덩어리 수 상한(달 안에서 고르게 띄운다)
export const SAMPLE_MIN_CHUNK_CHARS = 1500; // 덩어리 하나의 최소 몫(글자). 달 몫이 작으면 덩어리 수를 줄인다

// 통계
export const SILENCE_GAP_MS = 21_600_000; // 6시간
export const NIGHT_START = 22;
export const NIGHT_END = 5;

// 클라이언트·세션
export const POLL_MS = 3000;
export const NOTES_FLUSH_MS = 5000;
export const SESSION_COOKIE = "analytalk_session";
export const SESSION_TTL_DAYS = 30;
/** 초대 코드 화면의 Turnstile 위젯 action. 서버는 siteverify 응답의 action이 이것과 같아야 통과시킨다 */
export const TURNSTILE_INVITE_ACTION = "invite";

// 모델·테스트
export const DEFAULT_MODEL = "claude-sonnet-5-5";
export const E2E_INVITE_CODE = "E2ETESTCODE";

/** E2E 테스트 모드. Vercel에서는 절대 켜지지 않는다. */
export const isE2E = () => process.env.ANALYTALK_E2E === "1" && !process.env.VERCEL;
