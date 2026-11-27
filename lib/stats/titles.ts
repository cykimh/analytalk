// '누가 더 ___' 칭호 카드(v2.9). 코드가 통계로 정한다(AI 비용 없음). 1:1은 두 사람을 "A 값 vs B 값"으로 견주고, 단톡은 방 전체 1위 한 사람과 그 값.
// 데이터가 모자라면(문턱 미달·예전 통계에 필드 없음) 그 칭호는 뺀다. 이름은 stats의 키(뺀 멤버는 처음부터 없다)
import { formatCount, formatDuration, formatPercent } from "@/components/stats/format";
import { LONG_MESSAGE_CHARS } from "@/lib/config";
import type { ChatStats } from "./compute";
import { NIGHT_RANGE } from "./quips";

export interface TitleCard {
  key: "obsessed" | "speedy" | "ghost" | "laugh" | "essay" | "owl";
  emoji: string;
  /** 칭호 */
  title: string;
  /** 무엇으로 정했는지 한 줄 */
  desc: string;
  winner: string;
  value: string;
}

export const TITLE_RULES = {
  /** 먼저 말 걸기가 모두 합쳐 이만큼은 돼야 한다 */
  minInitiations: 5,
  /** 답장 속도를 견줄 사람의 메시지 수 하한(그런 사람이 둘 이상) */
  minReplyMessages: 10,
  minLaughChars: 10,
  /** 장문 비율을 견줄 사람의 글 메시지 수 하한 */
  minLongTexts: 20,
  /** 새벽요정의 밤 메시지 수 하한 */
  minNight: 5,
} as const;

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
type Row = [name: string, value: number];
/** 큰 순(동률은 이름 순) */
const desc = (rows: Row[]) => [...rows].sort(([a, x], [b, y]) => y - x || byName(a, b));
const asc = (rows: Row[]) => [...rows].sort(([a, x], [b, y]) => x - y || byName(a, b));
const rowsOf = (rec: Record<string, number | null | undefined> | undefined, keep: (name: string, v: number) => boolean = () => true): Row[] =>
  Object.entries(rec ?? {}).filter((e): e is Row => typeof e[1] === "number" && Number.isFinite(e[1]) && keep(e[0], e[1]));

/** 순위 rows(1위가 맨 앞)로 칭호 한 장: 1:1이면 두 사람, 아니면 1위만 */
function card(base: Omit<TitleCard, "winner" | "value">, ranked: Row[], pair: boolean, show: (v: number) => string, solo: (v: number) => string): TitleCard {
  const [[winner, v]] = ranked;
  const value = pair && ranked.length === 2 ? `${winner} ${show(v)} vs ${ranked[1][0]} ${show(ranked[1][1])}` : `${winner} · ${solo(v)}`;
  return { ...base, winner, value };
}

export function titleCards(stats: ChatStats): TitleCard[] {
  const pair = Object.keys(stats.byPerson).length === 2;
  const out: TitleCard[] = [];

  const starts = desc(rowsOf(stats.initiations));
  const totalStarts = starts.reduce((n, [, v]) => n + v, 0);
  if (totalStarts >= TITLE_RULES.minInitiations) {
    // 1:1 두 비율의 합이 100%가 되게 1위 비율을 먼저 반올림한다
    const first = Math.round((starts[0][1] / totalStarts) * 100);
    const shares: Row[] = starts.map(([name, v], i) => [name, i === 0 ? first : pair ? 100 - first : Math.round((v / totalStarts) * 100)]);
    out.push(card({ key: "obsessed", emoji: "📲", title: "집착왕", desc: "먼저 말 건 비율 1위" }, shares, pair, (v) => `${v}%`, (v) => `대화 시작의 ${v}%`));
  }

  const replies = rowsOf(stats.replyMedianMs, (name) => (stats.byPerson[name] ?? 0) >= TITLE_RULES.minReplyMessages);
  const fast = asc(replies);
  if (fast.length >= 2 && fast[0][1] < fast[fast.length - 1][1]) {
    out.push(card({ key: "speedy", emoji: "⚡", title: "광속답장러", desc: "답장 중앙값이 가장 짧다" }, fast, pair, formatDuration, (v) => `중앙값 ${formatDuration(v)}`));
    out.push(card({ key: "ghost", emoji: "👻", title: "읽씹 마스터", desc: "답장 중앙값이 가장 길다" }, desc(replies), pair, formatDuration, (v) => `중앙값 ${formatDuration(v)}`));
  }

  const laughs = desc(rowsOf(stats.laughChars));
  if (laughs.length > 0 && laughs[0][1] >= TITLE_RULES.minLaughChars) {
    const n = (v: number) => `${formatCount(v)}개`;
    out.push(card({ key: "laugh", emoji: "🤣", title: "ㅋ 폭격기", desc: "ㅋ를 가장 많이 썼다" }, laughs, pair, n, (v) => `ㅋ ${n(v)}`));
  }

  const long = desc(
    Object.entries(stats.style ?? {})
      .filter(([, st]) => st.texts >= TITLE_RULES.minLongTexts)
      .map(([name, st]): Row => [name, st.long / st.texts]),
  );
  if (long.length > 0 && long[0][1] > 0) {
    out.push(card({ key: "essay", emoji: "📜", title: "장문 장인", desc: `${LONG_MESSAGE_CHARS}자 이상 메시지 비율 1위` }, long, pair, formatPercent, (v) => `글의 ${formatPercent(v)}`));
  }

  const owls = desc(rowsOf(stats.nightByPerson));
  if (owls.length > 0 && owls[0][1] >= TITLE_RULES.minNight) {
    out.push(card({ key: "owl", emoji: "🦉", title: "새벽요정", desc: `${NIGHT_RANGE} 메시지 최다` }, owls, pair, (v) => `${formatCount(v)}개`, (v) => `밤 메시지 ${formatCount(v)}개`));
  }
  return out;
}
