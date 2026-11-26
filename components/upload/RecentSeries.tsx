"use client";

// 시작 화면의 '내 연재': 이 브라우저에서 만든 연재(/c/[id])로 돌아가는 링크. 서버에 목록 API가 없어 localStorage만 읽는다.
// 열릴 때 24시간 지난 재시도용 페이로드도 지운다(대화 화면에 다시 오지 않아도 PRD 데이터 표의 24시간을 지킨다).
import Link from "next/link";
import { useEffect, useState } from "react";
import { SERIES_TITLE } from "@/components/episode/model";
import { kstDate } from "@/components/stats/format";
import { sweepPayloads } from "@/lib/client/idb";
import { TONES } from "@/lib/llm/concepts";
import { listSeries, type RecentSeries as Entry } from "@/lib/client/recent";


export function RecentSeries() {
  const [entries, setEntries] = useState<Entry[]>([]);

  useEffect(() => {
    void sweepPayloads().catch(() => undefined);
    setEntries(listSeries());
  }, []);

  if (entries.length === 0) return null;
  return (
    <section aria-labelledby="recent-title" className="grid gap-2">
      <h2 id="recent-title" className="text-base font-bold">
        내 연재
      </h2>
      <ul className="grid gap-2">
        {entries.map((e) => (
          <li key={e.id}>
            <Link
              href={`/c/${e.id}`}
              className="flex min-h-11 min-w-0 items-baseline justify-between gap-2 rounded-lg border bg-sheet p-3 text-base hover:bg-muted"
            >
              <span className="min-w-0 font-medium wrap-anywhere">
                {SERIES_TITLE[e.concept]}
                {e.tone ? ` · ${TONES[e.tone].label}` : ""}
              </span>
              <span className="shrink-0 text-sm text-muted-foreground tabular-nums">{kstDate(e.createdAt)} 만듦</span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="text-base text-muted-foreground">이 브라우저에서 만든 것만 보여요. 30일이 지나면 사라져요.</p>
    </section>
  );
}
