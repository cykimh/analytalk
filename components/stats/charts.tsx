// 통계 화면의 작은 차트들(HTML·CSS 막대). 값은 텍스트로도 보이게 두고, 막대에는 title로 값을 단다.
// look: plain(업로드 화면, 원래 모양) · scrap(리포트 화면, 종이 카드 + 크레파스 단색 막대. DESIGN.md)
import type { ReactNode } from "react";
import { Paper } from "@/components/scrap/Paper";
import { alternate, tapeAt } from "@/components/scrap/tilt";
import { cn } from "@/lib/utils";

export type ChartLook = "plain" | "scrap";

/** 범주 색(고정 순서, 돌려 쓰지 않는다). 사람 순서(메시지 많은 순)대로 붙인다 */
export const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"] as const;
/** 크기(한 색, 밝음 → 어두움). 0단계는 바탕에 가깝다 */
export const SEQUENTIAL = ["#f0efec", "#cde2fb", "#86b6ef", "#3987e5", "#1c5cab"] as const;
export const SEQ_MAIN = "#2a78d6";

/** 크레파스 파스텔(따뜻한 색 위주). 차가운 파랑은 쓰지 않고, 여덟째에만 흐린 하늘색을 둔다 */
export const CRAYON_SERIES = ["#f08a5d", "#5fa8a0", "#e86a92", "#e2b33c", "#7db356", "#9b7bc9", "#c98b5b", "#86abc9"] as const;
/** 크레파스 한 색 단계: 종이 → 개나리 → 살구 → 귤 → 벽돌 */
export const CRAYON_SEQUENTIAL = ["#f3ece0", "#fbe3a6", "#f7be7a", "#ee8f56", "#c9583a"] as const;

export interface Palette {
  series: readonly string[];
  sequential: readonly string[];
  main: string;
  /** '그 밖 N명' 막대 */
  rest: string;
}

export const palette = (look: ChartLook): Palette =>
  look === "scrap"
    ? { series: CRAYON_SERIES, sequential: CRAYON_SEQUENTIAL, main: CRAYON_SERIES[0], rest: "#b9ab99" }
    : { series: SERIES, sequential: SEQUENTIAL, main: SEQ_MAIN, rest: "#898781" };

/** index는 scrap에서 카드 기울기·테이프를 고르는 순서(0부터) */
export function ChartCard({
  title,
  note,
  children,
  className,
  look = "plain",
  index = 0,
}: {
  title: string;
  note?: ReactNode;
  children: ReactNode;
  className?: string;
  look?: ChartLook;
  index?: number;
}) {
  if (look === "scrap") {
    return (
      <Paper as="section" tilt={alternate(index)} tape={tapeAt(index + 1)} className={cn("grid content-start gap-3 pt-5", className)}>
        <header className="grid gap-0.5">
          <h3 className="font-hand text-[1.375rem] leading-tight font-bold">{title}</h3>
          {note && <p className="text-[0.8125rem] text-ink-soft">{note}</p>}
        </header>
        {children}
      </Paper>
    );
  }
  return (
    <section className={cn("grid min-w-0 content-start gap-3 rounded-xl border bg-card p-4", className)}>
      <header className="grid gap-0.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </header>
      {children}
    </section>
  );
}

export interface BarRow {
  key: string;
  label: ReactNode;
  value: number;
  display: string;
  color: string;
}

/** 가로 막대 목록. 이름·값은 글자로 보이고 막대는 보조다 */
export function BarList({ rows, max, look = "plain" }: { rows: BarRow[]; max?: number; look?: ChartLook }) {
  const top = max ?? Math.max(0, ...rows.map((r) => r.value));
  const scrap = look === "scrap";
  return (
    <ul className="grid gap-2">
      {rows.map((r) => (
        <li key={r.key} className="grid gap-1 text-sm">
          <div className="flex min-w-0 items-baseline justify-between gap-2">
            <span className="min-w-0 truncate">{r.label}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{r.display}</span>
          </div>
          <div className={scrap ? "h-3 rounded-sm bg-muted" : "h-2 rounded-full bg-muted"} title={r.display}>
            <div
              className={scrap ? "crayon h-3" : "h-2 rounded-full"}
              style={{ width: `${top > 0 ? Math.max(2, (r.value / top) * 100) : 0}%`, backgroundColor: r.color }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** 세로 막대(시간대·요일·월별). titles는 막대마다 마우스를 올리면 보이는 값 */
export function Columns({
  values,
  titles,
  color,
  label,
  height = 64,
  max,
  look = "plain",
}: {
  values: (number | null)[];
  titles: string[];
  color: string;
  label: string;
  height?: number;
  max?: number;
  look?: ChartLook;
}) {
  const top = max ?? Math.max(0, ...values.map((v) => v ?? 0));
  return (
    <div role="img" aria-label={label} className="flex items-end gap-0.5" style={{ height }}>
      {values.map((v, i) => (
        <div key={i} title={titles[i]} className="flex h-full min-w-0 flex-1 items-end">
          <div
            className={look === "scrap" ? "crayon w-full" : "w-full rounded-t-[3px]"}
            style={{
              height: v === null || top <= 0 ? 0 : `${Math.max(v > 0 ? 4 : 0, (v / top) * 100)}%`,
              backgroundColor: color,
            }}
          />
        </div>
      ))}
    </div>
  );
}
