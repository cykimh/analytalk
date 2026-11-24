"use client";

// 시작 화면의 '내 연재': 이 브라우저에서 만든 연재(/c/[id])로 돌아가는 링크. 서버에 목록 API가 없어 localStorage만 읽는다.
// 열릴 때 24시간 지난 재시도용 페이로드도 지운다(대화 화면에 다시 오지 않아도 PRD 데이터 표의 24시간을 지킨다).
import Link from "next/link";
import { useEffect, useState } from "react";
import { kstDate } from "@/components/stats/format";
import { sweepPayloads } from "@/lib/client/idb";
import { listSeries, type RecentSeries as Entry } from "@/lib/client/recent";

const CONCEPT_TEXT: Record<Entry["concept"], string> = { couple: "둘의 대화 연재", group: "단톡방 연재" };

export function RecentSeries() {
  const [entries, setEntries] = useState<Entry[]>([]);

  useEffect(() => {
    void sweepPayloads().catch(() => undefined);
    setEntries(listSeries());
  }, []);

  if (entries.length === 0) return null;
  return (
    <section aria-labelledby="recent-title" className="grid gap-2">
      <h2 id="recent-title" className="text-sm font-semibold">
        내 연재
      </h2>
      <ul className="grid gap-2">
        {entries.map((e) => (
          <li key={e.id}>
            <Link
              href={`/c/${e.id}`}
              className="flex min-w-0 items-baseline justify-between gap-2 rounded-lg border p-3 text-sm hover:bg-muted"
            >
              <span className="font-medium">{CONCEPT_TEXT[e.concept]}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{kstDate(e.createdAt)} 만듦</span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">이 브라우저에서 만든 것만 보여요. 30일이 지나면 사라져요.</p>
    </section>
  );
}
