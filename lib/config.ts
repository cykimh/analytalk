// PRD 확정 수치. 값을 바꾸면 PRD도 함께 고친다.

// 편 생성 (서버)
export const EPISODE_DEADLINE_MS = 270_000; // 편당 마감 (maxDuration = 300)
export const MAX_PAYLOAD_BYTES = 4_000_000; // 페이로드 상한 4MB
export const TOKENS_PER_CHAR = 1.0;
/** 모델별 입력 예산(토큰). 표 밖의 모델은 FALLBACK. 서버의 INPUT_TOKEN_BUDGET env가 이 값을 덮어쓴다 */
export const INPUT_TOKEN_BUDGET_BY_MODEL: readonly (readonly [string, number])[] = [
  ["claude-sonnet-5-5", 400_000],
  ["claude-opus-5-5", 128_000],
];
export const FALLBACK_INPUT_TOKEN_BUDGET = 128_000;
/** 날짜가 붙은 스냅샷 id도 같은 모델로 본다(lib/llm/cost.ts priceOf와 같은 규칙) */
export function inputTokenBudgetFor(model: string): number {
  const hit = INPUT_TOKEN_BUDGET_BY_MODEL.find(([id]) => model === id || model.startsWith(`${id}-`));
  return hit ? hit[1] : FALLBACK_INPUT_TOKEN_BUDGET;
}
export const PROMPT_RESERVE_TOKENS = 6000; // system 프롬프트·편별 지시 몫(토큰 어림). 정확한 값은 countTokens로 확인한다

// 모델에게 보여 주는 통계 요약(statsForPrompt). 서버의 자리표시자 해석은 전체 stats를 쓴다
export const PROMPT_STATS_MAX_PEOPLE = 12;
export const PROMPT_STATS_MAX_MONTHS = 12;
export const PROMPT_STATS_MAX_CROSSED = 20;

// 보관·한도·예산
export const RETENTION_DAYS = 30;
export const DEFAULT_MONTHLY_LIMIT = 2; // 초대 코드 기본 월 한도(건)
export const WEEKLY_CAP_USD = 22.5; // 전역 주간 차단
export const MONTHLY_BUDGET_USD = 90;
export const DEFAULT_EST_COST_USD = 1.2; // 실측 전 건당 추정 원가(대화 한 건 = 리포트 한 번). 실측 뒤 보정
export const MAX_REPORT_RUNS = 3; // 리포트의 유료 실행 상한(처음 1번 + [다시 쓰기] 2번). 넘으면 retry가 429 retry_limit
export const CYCLE_ANCHOR_DAY = 1; // 크레딧 주기 기준일(서울 00:00 시작). settings.cycle_anchor_day 기본값과 같다

// 검증
export const MAX_QUOTES_PER_EPISODE = 8;
export const PARTIAL_DROP_RATIO = 0.3; // 문단 30% 이상 삭제되면 partial
export const RECOGNITION_WARN = 0.98; // 줄 인식률 경고 기준
export const NOTE_MAX_CHARS = 60;
export const MAX_READING_NOTES = 20; // 저장·표시하는 reading_notes 개수 상한

// 통계·앵커
export const ANCHOR_FIRST_N = 100;
export const ANCHOR_BUSY_DAYS = 3;
// buildPayload tokenBudget(anchors+transcript) 중 anchors 상한. PRD의 anchors 약 10K / (anchors+transcript) 약 120K
export const ANCHOR_BUDGET_SHARE = 0.08;
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
export const DEFAULT_MODEL = "claude-opus-5-5";
export const E2E_INVITE_CODE = "E2ETESTCODE";

/** E2E 테스트 모드. Vercel에서는 절대 켜지지 않는다. */
export const isE2E = () => process.env.ANALYTALK_E2E === "1" && !process.env.VERCEL;
