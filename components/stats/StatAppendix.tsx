// 숫자 부록(v2.9): 리포트 끝(마무리 뒤)에 읽씹 리포트·대화 버릇·자주 쓰는 단어 TOP 10을 종이 카드로 쌓는다(#report-capture 안, 버튼 없음).
// 값은 lib/stats/details가 통계로 만든다. 예전 통계(필드 없음)는 빈 목록이라 그 카드를 빼고, 셋 다 없으면 부록을 그리지 않는다.
// 대화 버릇 표는 375px에서 칸이 좁아지지 않게 메시지 많은 4명까지(table-fixed), 줄마다 1위 칸을 굵게
import { Sticker } from "@/components/scrap/Sticker";
import { formatCount } from "@/components/stats/format";
import type { ChatStats } from "@/lib/stats/compute";
import { habitTable, unansweredRows, wordRows } from "@/lib/stats/details";
import { ChartCard } from "./charts";

export function StatAppendix({ stats }: { stats: ChatStats }) {
  const unanswered = unansweredRows(stats);
  const habits = habitTable(stats);
  const words = wordRows(stats);
  if (unanswered.length + habits.rows.length + words.length === 0) return null;
  return (
    <section aria-labelledby="report-appendix" className="grid min-w-0 grid-cols-1 gap-3">
      <p id="report-appendix" className="flex items-center gap-3 px-1 text-[0.875rem] font-bold text-ink-soft">
        부록 · 숫자로 본 이 방
        <span aria-hidden className="h-px flex-1 bg-ink/15" />
      </p>
      <div className="grid min-w-0 grid-cols-1 gap-4">
        {unanswered.length > 0 && (
          <ChartCard look="scrap" title="읽씹 리포트" note="한 사람이 이어 보낸 메시지(차례) 뒤 6시간 안에 아무도 답하지 않은 횟수예요.">
            <ul role="list" className="grid gap-3">
              {unanswered.map((r) => (
                <li key={r.name} className="grid gap-0.5 text-base">
                  <span className="font-bold wrap-anywhere">{r.name}</span>
                  <span className="tabular-nums">
                    답 못 받은 차례 {formatCount(r.ignored)}번 / {formatCount(r.turns)}번({r.rate})
                  </span>
                  <span className="text-ink-soft tabular-nums">
                    가장 오래 기다림 {r.maxWait} · 연속 최대 {formatCount(r.maxStreak)}번
                  </span>
                </li>
              ))}
            </ul>
          </ChartCard>
        )}
        {habits.rows.length > 0 && (
          <ChartCard look="scrap" title="대화 버릇" note="글 메시지 가운데 그 버릇이 든 비율이에요. 굵은 칸이 그 줄 1위예요.">
            <table className="w-full table-fixed border-collapse text-[0.9375rem] tabular-nums">
              <thead>
                <tr className="border-b border-ink/15">
                  <th scope="col" className="w-[34%] py-1.5 pr-1 text-left font-normal text-ink-soft">
                    버릇
                  </th>
                  {habits.people.map((name) => (
                    <th key={name} scope="col" className="truncate px-1 py-1.5 text-right font-bold">
                      {name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {habits.rows.map((row) => (
                  <tr key={row.key} className="border-b border-ink/10 last:border-b-0">
                    <th scope="row" className="py-1.5 pr-1 text-left font-normal wrap-anywhere">
                      {row.label}
                    </th>
                    {row.values.map((v, i) => (
                      <td key={habits.people[i]} className={i === row.top ? "px-1 py-1.5 text-right font-bold" : "px-1 py-1.5 text-right text-ink-soft"}>
                        {v}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </ChartCard>
        )}
        {words.length > 0 && (
          <ChartCard look="scrap" title="자주 쓰는 단어 TOP 10" note="두 번 이상 쓴 두 글자 이상 단어예요. 흔한 말·조사·웃음은 뺐어요.">
            <div className="grid gap-4">
              {words.map((w) => (
                <div key={w.name} className="grid gap-1.5">
                  <p className="text-base font-bold wrap-anywhere">{w.name}</p>
                  <ol className="flex min-w-0 flex-wrap gap-1.5">
                    {w.words.map(([word, n]) => (
                      <li key={word} className="min-w-0">
                        <Sticker className="tabular-nums">
                          {word} <span className="text-ink-soft">{formatCount(n)}</span>
                        </Sticker>
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
          </ChartCard>
        )}
      </div>
    </section>
  );
}
