// 통계 대시보드(payload.stats 기준). 숫자는 코드가 센 것이고, 해석은 하지 않는다.
// 달력 히트맵, 대화 지분, 선톡·마무리, 월별 답장 간격, 시간대·요일, ㅋ 길이, 질문 비율, 최장 연속일, 가장 많았던 날, (1:1) 엇갈린 패턴
// look: plain(업로드 화면, 둥근 카드) · scrap(대화 홈. 카드는 한 줄로 쌓고 번갈아 기울인다. DESIGN.md). 색은 둘 다 크레파스.
// scrap의 숫자 칸은 최장 연속·심야 비율만 둔다: 메시지 수·가장 많았던 날은 대화 홈 위쪽 폴라로이드(KpiPolaroids)가 보여 준다
import type { ReactNode } from "react";
import { Paper } from "@/components/scrap/Paper";
import { alternate } from "@/components/scrap/tilt";
import type { Payload } from "@/lib/payload/build";
import type { ChatStats } from "@/lib/stats/compute";
import { cn } from "@/lib/utils";
import { AXIS_TEXT, BarList, ChartCard, type ChartLook, ColumnTicks, Columns, PALETTE, shortMonth } from "./charts";
import { crossedText, formatCount, formatDuration, formatPercent, heatLevel, heatmapRows, topPeople } from "./format";

const MAX_BAR_PEOPLE = PALETTE.series.length;
const MAX_SMALL_MULTIPLES = 4;
const MAX_HEATMAP_MONTHS = 24;
const MAX_REPLY_MONTHS = 12;
const MAX_CROSSED = 3;
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
/** ㅋ 길이 막대(1 ~ 10개 이상) 아래 눈금 글자 */
const LAUGH_TICKS = ["1", null, null, "4", null, null, "7", null, null, "10+"];


function Tile({ label, value, sub, look, index = 0 }: { label: string; value: ReactNode; sub?: ReactNode; look: ChartLook; index?: number }) {
  if (look === "scrap") {
    return (
      <Paper tone="kraft" tilt={alternate(index + 1)} className="grid gap-0.5 p-3">
        <span className="text-base leading-tight font-bold">{label}</span>
        <span className="truncate text-xl font-bold tabular-nums">{value}</span>
        {sub && <span className="truncate text-sm text-ink-soft">{sub}</span>}
      </Paper>
    );
  }
  return (
    <div className="grid min-w-0 gap-0.5 rounded-xl bg-muted p-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="truncate text-lg font-semibold tabular-nums">{value}</span>
      {sub && <span className="truncate text-sm text-muted-foreground">{sub}</span>}
    </div>
  );
}

function Heatmap({ dailyCounts, look }: { dailyCounts: Record<string, number>; look: ChartLook }) {
  const all = heatmapRows(dailyCounts);
  const rows = all.slice(-MAX_HEATMAP_MONTHS);
  const max = Math.max(0, ...Object.values(dailyCounts));
  const { sequential } = PALETTE;
  return (
    <ChartCard
      title="달력 히트맵"
      note={all.length > rows.length ? `최근 ${rows.length}개월 (전체 ${all.length}개월)` : "날마다 메시지 수"}
      look={look}
      index={0}
    >
      <div
        role="img"
        aria-label="날짜별 메시지 수 달력"
        className="grid gap-0.5"
        style={{ gridTemplateColumns: `${look === "scrap" ? "3.75rem" : "3.25rem"} repeat(31, minmax(0, 1fr))` }}
      >
        {rows.map((row) => [
          <span key={`${row.month}-label`} className={cn(AXIS_TEXT, "leading-3")}>
            {row.month}
          </span>,
          ...row.days.map((count, i) => (
            <span
              key={`${row.month}-${i}`}
              title={count === null ? undefined : `${row.month}-${String(i + 1).padStart(2, "0")} · ${formatCount(count)}개`}
              className="aspect-square min-w-0 rounded-[2px]"
              style={{ backgroundColor: count === null ? "transparent" : sequential[heatLevel(count, max)] }}
            />
          )),
        ])}
      </div>
      <div className={cn(AXIS_TEXT, "flex items-center gap-1")}>
        적음
        {sequential.map((c) => (
          <span key={c} aria-hidden className="size-2.5 rounded-[2px]" style={{ backgroundColor: c }} />
        ))}
        많음
      </div>
    </ChartCard>
  );
}

type PartProps = { stats: ChatStats; people: string[]; color: (p: string) => string; look: ChartLook };

function ReplyByMonth({ stats, people, color, look }: PartProps) {
  const months = Object.keys(stats.monthly).sort().slice(-MAX_REPLY_MONTHS);
  const value = (m: string, p: string) => stats.monthly[m].replyMedianMs[p] ?? null;
  // 사람끼리 같은 눈금
  const max = Math.max(0, ...months.flatMap((m) => people.map((p) => value(m, p) ?? 0)));
  if (months.length === 0 || max === 0) {
    return (
      <ChartCard title="답장 간격 (월별)" look={look} index={3}>
        <p className="text-base text-muted-foreground">답장으로 볼 메시지가 아직 적어요.</p>
      </ChartCard>
    );
  }
  return (
    <ChartCard title="답장 간격 (월별)" note="달마다 답장까지 걸린 시간의 중앙값이에요. 막대가 높을수록 늦게 답했어요." look={look} index={3}>
      <div className="grid gap-4">
        {people.map((p) => (
          <div key={p} className="grid gap-1">
            <div className="flex min-w-0 items-baseline justify-between gap-2 text-base">
              <span className="min-w-0 truncate">
                {p}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">전체 {formatDuration(stats.replyMedianMs[p] ?? null)}</span>
            </div>
            <Columns
              label={`${p}의 월별 답장 간격`}
              values={months.map((m) => value(m, p))}
              titles={months.map((m) => `${m} · ${formatDuration(value(m, p))}`)}
              color={color(p)}
              height={40}
              max={max}
              look={look}
            />
            <div className={cn(AXIS_TEXT, "flex justify-between gap-2")}>
              <span>{shortMonth(months[0])}</span>
              {months.length > 1 && <span>{shortMonth(months[months.length - 1])}</span>}
            </div>
          </div>
        ))}
      </div>
    </ChartCard>
  );
}

function Laugh({ stats, people, color, look }: PartProps) {
  const rows = people.filter((p) => (stats.laughLength[p] ?? []).some((n) => n > 0));
  return (
    <ChartCard
      title="ㅋ 길이"
      note={`ㅋ·ㅎ를 한 번에 몇 개씩 이어 쓰는지예요.${rows.length > 0 ? " 진한 막대가 가장 자주 쓴 길이예요." : ""}`}
      look={look}
      index={5}
    >
      {rows.length === 0 ? (
        <p className="text-base text-muted-foreground">ㅋ·ㅎ가 없어요.</p>
      ) : (
        <div className="grid gap-4">
          {rows.map((p) => {
            const hist = stats.laughLength[p].slice(1);
            const mode = hist.indexOf(Math.max(...hist)) + 1;
            return (
              <div key={p} className="grid gap-1">
                <div className="flex min-w-0 items-baseline justify-between gap-2 text-base">
                  <span className="min-w-0 truncate">
                    {p}
                  </span>
                  <span className="shrink-0 text-muted-foreground">주로 {mode === 10 ? "10개 이상" : `${mode}개`}</span>
                </div>
                <Columns
                  label={`${p}의 ㅋ 길이 분포`}
                  values={hist}
                  titles={hist.map((n, i) => `${i + 1 === 10 ? "10개 이상" : `${i + 1}개`} · ${formatCount(n)}번`)}
                  color={color(p)}
                  height={32}
                  look={look}
                  emphasis={mode - 1}
                />
                <ColumnTicks labels={LAUGH_TICKS} />
              </div>
            );
          })}
        </div>
      )}
    </ChartCard>
  );
}

function Crossed({ stats, look }: { stats: ChatStats; look: ChartLook }) {
  const items = [...stats.crossed].sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0)).slice(0, MAX_CROSSED);
  return (
    <ChartCard title="엇갈린 패턴" note="한 지표는 오르고 다른 지표는 내린 달이에요. 숫자만 보여 드려요." look={look} index={7}>
      {items.length === 0 ? (
        <p className="text-base text-muted-foreground">눈에 띄게 엇갈린 달은 없었어요.</p>
      ) : (
        <ul className="grid gap-2">
          {items.map((c) => (
            <li key={`${c.month}-${c.person}`} className="grid gap-0.5 rounded-lg bg-muted p-3 text-base">
              <span className="text-sm text-muted-foreground">
                {c.month} · {c.person}
              </span>
              <span>{crossedText(c)}</span>
            </li>
          ))}
        </ul>
      )}
    </ChartCard>
  );
}

export function StatsDashboard({
  stats,
  kind,
  look = "plain",
}: {
  stats: ChatStats;
  kind: Payload["kind"];
  look?: ChartLook;
}) {
  const { people, rest } = topPeople(stats, MAX_BAR_PEOPLE);
  const multiples = people.slice(0, MAX_SMALL_MULTIPLES);
  const colors = PALETTE;
  const colorOf = new Map(people.map((p, i) => [p, colors.series[i]]));
  const color = (p: string) => colorOf.get(p) ?? colors.series[0];
  const scrap = look === "scrap";
  const restNote = rest > 0 ? `메시지 많은 ${people.length}명 (그 밖 ${rest}명)` : undefined;
  const restShare = Object.entries(stats.share)
    .filter(([p]) => !colorOf.has(p))
    .reduce((a, [, v]) => a + v, 0);

  return (
    <div className={cn("grid min-w-0", scrap ? "gap-6" : "gap-3")}>
      {scrap ? (
        <div className="grid grid-cols-2 gap-3">
          <Tile label="최장 연속" value={`${formatCount(stats.longestStreakDays)}일`} sub="매일 대화한 날" look={look} index={0} />
          <Tile label="심야 비율" value={formatPercent(stats.nightRatio)} sub="22시 ~ 5시" look={look} index={1} />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Tile label="메시지" value={`${formatCount(stats.total)}개`} look={look} />
          <Tile label="최장 연속" value={`${formatCount(stats.longestStreakDays)}일`} sub="매일 대화한 날" look={look} />
          <Tile
            label="가장 많았던 날"
            value={stats.busiestDay ? `${formatCount(stats.busiestDay.count)}개` : "-"}
            sub={stats.busiestDay?.date}
            look={look}
          />
          <Tile label="심야 비율" value={formatPercent(stats.nightRatio)} sub="22시 ~ 5시" look={look} />
        </div>
      )}

      <div className={cn("grid min-w-0", scrap ? "gap-6" : "gap-3 sm:grid-cols-2")}>
        <Heatmap dailyCounts={stats.dailyCounts} look={look} />

        <ChartCard title="대화 지분" note={restNote} look={look} index={1}>
          <BarList
            look={look}
            max={1}
            rows={[
              ...people.map((p) => ({
                key: p,
                label: p,
                value: stats.share[p] ?? 0,
                display: `${formatPercent(stats.share[p] ?? 0)} · ${formatCount(stats.byPerson[p] ?? 0)}개`,
                color: color(p),
              })),
              ...(rest > 0
                ? [{ key: "rest", label: `그 밖 ${rest}명`, value: restShare, display: formatPercent(restShare), color: colors.rest }]
                : []),
            ]}
          />
        </ChartCard>

        <ChartCard title="선톡 · 마무리" note="6시간 넘게 조용하다가 먼저 말한 횟수 · 마지막으로 말한 횟수" look={look} index={2}>
          <table className="w-full text-base">
            <thead className="text-sm text-muted-foreground">
              <tr>
                <th className="text-left font-normal">이름</th>
                <th className="text-right font-normal">선톡</th>
                <th className="text-right font-normal">마무리</th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p} className={cn("border-t", scrap && "border-dashed border-ink/20")}>
                  <td className="max-w-0 truncate py-1.5">
                    <span aria-hidden className="mr-1.5 inline-block size-2.5 rounded-sm align-middle" style={{ backgroundColor: color(p) }} />
                    {p}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{formatCount(stats.initiations[p] ?? 0)}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatCount(stats.closings[p] ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ChartCard>

        <ReplyByMonth stats={stats} people={multiples} color={color} look={look} />

        <ChartCard title="시간대 · 요일" note={`심야(22~5시) ${formatPercent(stats.nightRatio)}`} look={look} index={4}>
          <div className="grid gap-1">
            <Columns
              label="시간대별 메시지 수"
              values={stats.hourHistogram}
              titles={stats.hourHistogram.map((n, h) => `${h}시 · ${formatCount(n)}개`)}
              color={colors.main}
              look={look}
            />
            <div className={cn(AXIS_TEXT, "flex justify-between")}>
              <span>0시</span>
              <span>6시</span>
              <span>12시</span>
              <span>18시</span>
              <span>23시</span>
            </div>
          </div>
          <div className="grid gap-1">
            <Columns
              label="요일별 메시지 수"
              values={stats.weekdayHistogram}
              titles={stats.weekdayHistogram.map((n, d) => `${WEEKDAYS[d]}요일 · ${formatCount(n)}개`)}
              color={colors.main}
              height={48}
              look={look}
            />
            <div className={cn(AXIS_TEXT, "flex gap-0.5")}>
              {WEEKDAYS.map((d) => (
                <span key={d} className="flex-1 text-center">
                  {d}
                </span>
              ))}
            </div>
          </div>
        </ChartCard>

        <Laugh stats={stats} people={multiples} color={color} look={look} />

        <ChartCard
          title="질문 비율"
          note="보낸 글 중 물음표가 든 비율"
          className={kind === "pair" || scrap ? undefined : "sm:col-span-2"}
          look={look}
          index={6}
        >
          <BarList
            look={look}
            max={1}
            rows={people.map((p) => ({
              key: p,
              label: p,
              value: stats.questionRate[p] ?? 0,
              display: formatPercent(stats.questionRate[p] ?? 0),
              color: color(p),
            }))}
          />
        </ChartCard>

        {kind === "pair" && <Crossed stats={stats} look={look} />}
      </div>
    </div>
  );
}
