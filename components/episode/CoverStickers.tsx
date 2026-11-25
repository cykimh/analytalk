// 리포트 표지의 종이 스티커 줄: 컨셉 → 기간 → 멤버 이름(많으면 앞의 몇 명과 '외 N명') → (있으면) 손글씨 꼬리말.
// 꼬리말은 공유 화면의 "…의 대화"처럼 이름 스티커 뒤에 이어 쓰는 말이다
import { Sticker } from "@/components/scrap/Sticker";
import { periodOf } from "@/components/stats/format";
import { CONCEPTS } from "@/lib/llm/concepts";

const MAX_NAME_STICKERS = 6;

export function CoverStickers({
  concept,
  names,
  dailyCounts,
  suffix,
}: {
  concept: keyof typeof CONCEPTS;
  names: string[];
  dailyCounts: Record<string, number>;
  suffix?: string;
}) {
  const period = periodOf(dailyCounts);
  const shown = names.slice(0, MAX_NAME_STICKERS);
  const more = names.length - shown.length;
  let i = 0;
  return (
    <ul role="list" className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-2">
      <li className="min-w-0">
        <Sticker index={i++} tone="lilac">
          {CONCEPTS[concept].title}
        </Sticker>
      </li>
      {period && (
        <li className="min-w-0">
          <Sticker index={i++} tone="kraft" className="tabular-nums">
            {period.from === period.to ? period.from : `${period.from} ~ ${period.to}`}
          </Sticker>
        </li>
      )}
      {shown.map((name, k) => (
        <li key={`${k}-${name}`} className="min-w-0">
          <Sticker index={i++} tone={(["butter", "mint", "pink", "sky"] as const)[k % 4]}>
            {name}
          </Sticker>
        </li>
      ))}
      {more > 0 && (
        <li className="min-w-0">
          <Sticker index={i++} tone="kraft">
            외 {more}명
          </Sticker>
        </li>
      )}
      {suffix && <li className="font-hand text-xl leading-none font-bold">{suffix}</li>}
    </ul>
  );
}
