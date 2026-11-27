// 핵심 숫자 세 장(폴라로이드): 주고받은 메시지 · 함께한 날(첫 메시지 ~ 마지막 메시지, 양 끝 포함) · 가장 뜨거웠던 날.
// 숫자는 코드가 센 것이고 해석하지 않는다. v2.9: 스트립 아래 가운데에 메시지 수 구간의 재치 한 줄(lib/stats/quips, 코드가 고른 고정 문구)
import { Polaroid, PolaroidStrip } from "@/components/scrap/Polaroid";
import type { ChatStats } from "@/lib/stats/compute";
import { messageQuip } from "@/lib/stats/quips";
import { cn } from "@/lib/utils";
import { formatCount, periodOf } from "./format";

export function KpiPolaroids({ stats, className }: { stats: Pick<ChatStats, "total" | "dailyCounts" | "busiestDay">; className?: string }) {
  const period = periodOf(stats.dailyCounts);
  return (
    <div className={cn("grid gap-2", className)}>
      <PolaroidStrip>
        <Polaroid index={0} tone="butter" caption="주고받은 메시지" value={formatCount(stats.total)} unit="개" />
        <Polaroid index={1} tone="mint" caption="함께한 날" value={period ? formatCount(period.days) : "-"} unit={period ? "일" : undefined} />
        <Polaroid
          index={2}
          tone="pink"
          caption="가장 뜨거웠던 날"
          value={stats.busiestDay ? formatCount(stats.busiestDay.count) : "-"}
          unit={stats.busiestDay ? "개" : undefined}
          sub={stats.busiestDay?.date}
        />
      </PolaroidStrip>
      {stats.total > 0 && (
        <p className="px-1 text-center text-base text-ink-soft">
          <span aria-hidden>📚 </span>
          {messageQuip(stats.total)}
        </p>
      )}
    </div>
  );
}
