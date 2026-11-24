// PRD 확정 수치. 값을 바꾸면 PRD도 함께 고친다.

// 편 생성 (서버)
export const EPISODE_DEADLINE_MS = 270_000; // 편당 마감 (maxDuration = 300)
export const MAX_PAYLOAD_BYTES = 1_500_000; // 페이로드 상한 1.5MB
export const INPUT_TOKEN_BUDGET = 128_000; // 입력 예산 (M0 실측 전 기본값)
export const TOKENS_PER_CHAR = 1.0;

// 보관·한도·예산
export const RETENTION_DAYS = 30;
export const DEFAULT_MONTHLY_LIMIT = 2; // 초대 코드 기본 월 한도(건)
export const WEEKLY_CAP_USD = 22.5; // 전역 주간 차단
export const MONTHLY_BUDGET_USD = 90;
export const DEFAULT_EST_COST_USD = 1.31; // 실측 전 건당 추정 원가

// 검증
export const MAX_QUOTES_PER_EPISODE = 8;
export const PARTIAL_DROP_RATIO = 0.3; // 문단 30% 이상 삭제되면 partial
export const RECOGNITION_WARN = 0.98; // 줄 인식률 경고 기준
export const NOTE_MAX_CHARS = 60;

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

// 모델·테스트
export const DEFAULT_MODEL = "claude-opus-5-5";
export const E2E_INVITE_CODE = "E2ETESTCODE";

/** E2E 테스트 모드. Vercel에서는 절대 켜지지 않는다. */
export const isE2E = () => process.env.ANALYTALK_E2E === "1" && !process.env.VERCEL;
