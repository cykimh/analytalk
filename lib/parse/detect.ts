import { CSV_ROW_HEAD, FORMAT_IDS, type FormatId, parseNotice, TEXT_FORMATS, type TextFormat } from "./formats";

export const DETECT_SAMPLE_LINES = 300;
export const DETECT_MIN_SCORE = 0.5;

/** 형식의 머리 모양(메시지·날짜 구분선·사전에 맞는 시스템 줄)에 맞는 줄인가 */
function isHeadLine(fmt: TextFormat, line: string): boolean {
  if (fmt.message(line) || fmt.dateLine(line)) return true;
  const n = fmt.notice(line);
  return n !== null && parseNotice(n.text) !== null;
}

/**
 * 헤더를 뺀 본문 줄 중 비어 있지 않은 처음 300줄로 형식마다 매칭률을 매겨 가장 높은 형식을 고른다.
 * 최고 점수가 0.5 미만이면 formatId는 null이다. score는 고른(또는 가장 높았던) 형식의 매칭률이다.
 */
export function detectFormat(lines: readonly string[]): { formatId: FormatId | null; score: number } {
  const sample: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    sample.push(line);
    if (sample.length === DETECT_SAMPLE_LINES) break;
  }
  if (sample.length === 0) return { formatId: null, score: 0 };

  let best: FormatId | null = null;
  let bestScore = 0;
  for (const id of FORMAT_IDS) {
    const hits =
      id === "mac-csv"
        ? sample.filter((l) => CSV_ROW_HEAD.test(l)).length
        : sample.filter((l) => isHeadLine(TEXT_FORMATS[id], l)).length;
    const score = hits / sample.length;
    if (score > bestScore) {
      best = id;
      bestScore = score;
    }
  }
  return { formatId: bestScore >= DETECT_MIN_SCORE ? best : null, score: bestScore };
}
