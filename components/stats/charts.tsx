// 통계 화면의 작은 차트들(HTML·CSS 막대). 값은 텍스트로도 보이게 두고, 막대에는 title로 값을 단다.
// look: plain(업로드 화면, 둥근 카드) · scrap(리포트 화면, 종이 카드 + 테이프 + 크레파스 결 막대. DESIGN.md). 색은 둘 다 크레파스(PALETTE)
import type { ReactNode } from "react";
import { Paper } from "@/components/scrap/Paper";
import { alternate, tapeAt } from "@/components/scrap/tilt";
import { cn } from "@/lib/utils";

export type ChartLook = "plain" | "scrap";

/** 크레파스 파스텔(따뜻한 색 위주). 차가운 파랑은 쓰지 않고, 여덟째에만 흐린 하늘색을 둔다. 사람 순서(메시지 많은 순)대로 붙인다 */
export const CRAYON_SERIES = ["#f08a5d", "#5fa8a0", "#e86a92", "#e2b33c", "#7db356", "#9b7bc9", "#c98b5b", "#86abc9"] as const;
/** 크레파스 한 색 단계: 종이 → 개나리 → 살구 → 귤 → 벽돌. 0단계는 바탕에 가깝다 */
export const CRAYON_SEQUENTIAL = ["#f3ece0", "#fbe3a6", "#f7be7a", "#ee8f56", "#c9583a"] as const;

/**
 * 차트 색. 업로드 화면(plain)과 리포트 화면(scrap)이 같은 크레파스 색을 쓰고, 카드 모양만 다르다.
 * 따뜻한 종이 바탕에서 원색 파랑 대시보드처럼 튀지 않게, 같은 통계가 두 화면에서 같은 색으로 보이게 한다
 */
export const PALETTE = {
  series: CRAYON_SERIES,
  sequential: CRAYON_SEQUENTIAL,
  main: CRAYON_SERIES[0],
  /** '그 밖 N명' 막대 */
  rest: "#b9ab99",
} as const;

/** 축·범례 글자(짧은 라벨이라 12px). 문장으로 읽는 설명은 16px이다 */
export const AXIS_TEXT = "text-xs tabular-nums text-muted-foreground";

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
        <header className="grid gap-1">
          <h3 className="font-hand text-[1.375rem] leading-tight font-bold">{title}</h3>
          {note && <p className="text-base leading-snug text-ink-soft">{note}</p>}
        </header>
        {children}
      </Paper>
    );
  }
  return (
    <section className={cn("grid min-w-0 content-start gap-3 rounded-xl border bg-card p-4", className)}>
      <header className="grid gap-1">
        <h3 className="text-base font-bold">{title}</h3>
        {note && <p className="text-base leading-snug text-muted-foreground">{note}</p>}
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
    <ul className="grid gap-2.5">
      {rows.map((r) => (
        <li key={r.key} className="grid gap-1 text-base">
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

/**
 * 세로 막대(시간대·요일·월별·ㅋ 길이). titles는 막대마다 마우스를 올리면 보이는 값.
 * 바닥에 옅은 점선 기준선을 깔고, 값이 없거나 0인 칸은 기준선 위 낮은 회색 눈금으로 둔다(빈칸으로 두면 막대가 떠 보인다).
 * emphasis를 주면 그 칸만 진하게, 나머지는 옅게 그린다(ㅋ 길이의 가장 잦은 길이)
 */
export function Columns({
  values,
  titles,
  color,
  label,
  height = 64,
  max,
  look = "plain",
  emphasis,
}: {
  values: (number | null)[];
  titles: string[];
  color: string;
  label: string;
  height?: number;
  max?: number;
  look?: ChartLook;
  emphasis?: number;
}) {
  const top = max ?? Math.max(0, ...values.map((v) => v ?? 0));
  return (
    <div role="img" aria-label={label} className="flex items-end gap-0.5 border-b border-dashed border-ink/30" style={{ height }}>
      {values.map((v, i) => (
        <div key={i} title={titles[i]} className="flex h-full min-w-0 flex-1 items-end">
          {v === null || v <= 0 || top <= 0 ? (
            <div className="mb-px h-[3px] w-full rounded-[1px] bg-ink/15" />
          ) : (
            <div
              className={look === "scrap" ? "crayon w-full" : "w-full rounded-t-[3px]"}
              style={{
                height: `${Math.max(4, (v / top) * 100)}%`,
                backgroundColor: color,
                opacity: emphasis === undefined || emphasis === i ? undefined : 0.38,
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/** 세로 막대 아래 축 글자. labels[i]가 있는 칸 가운데에만 단다(Columns와 같은 칸 나눔) */
export function ColumnTicks({ labels }: { labels: (string | null)[] }) {
  return (
    <div className={cn(AXIS_TEXT, "flex gap-0.5")}>
      {labels.map((l, i) => (
        <span key={i} className="min-w-0 flex-1 text-center whitespace-nowrap">
          {l}
        </span>
      ))}
    </div>
  );
}

/** "2025-05" → "25년 5월"(월별 막대의 첫·끝 달 축 글자) */
export const shortMonth = (month: string) => `${month.slice(2, 4)}년 ${Number(month.slice(5, 7))}월`;
