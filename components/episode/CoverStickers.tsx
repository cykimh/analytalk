// 리포트 표지의 종이 스티커 줄: 컨셉 → 기간 → 멤버 이름(많으면 앞의 몇 명과 '외 N명')
import { Sticker } from "@/components/scrap/Sticker";
import { periodOf } from "@/components/stats/format";
import { CONCEPTS } from "@/lib/llm/concepts";

const MAX_NAME_STICKERS = 6;

export function CoverStickers({
  concept,
  names,
  dailyCounts,
}: {
  concept: keyof typeof CONCEPTS;
  names: string[];
  dailyCounts: Record<string, number>;
}) {
  const period = periodOf(dailyCounts);
  const shown = names.slice(0, MAX_NAME_STICKERS);
  const more = names.length - shown.length;
  let i = 0;
  return (
    <ul role="list" className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-2">
      <li className="min-w-0">
        <Sticker index={i++}>
          {CONCEPTS[concept].title}
        </Sticker>
      </li>
      {period && (
        <li className="min-w-0">
          <Sticker index={i++} className="tabular-nums">
            {period.from === period.to ? period.from : `${period.from} ~ ${period.to}`}
          </Sticker>
        </li>
      )}
      {shown.map((name, k) => (
        <li key={`${k}-${name}`} className="min-w-0">
          <Sticker index={i++}>
            {name}
          </Sticker>
        </li>
      ))}
      {more > 0 && (
        <li className="min-w-0">
          <Sticker index={i++}>
            외 {more}명
          </Sticker>
        </li>
      )}
    </ul>
  );
}
