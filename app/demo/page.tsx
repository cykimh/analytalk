// /demo: 로그인(초대 코드) 없이 보는 데모 리포트 한 편(v2.8). 운영에서도 열린다. 가짜 단톡방(lib/demo)으로 만든 정적인 리포트라
// 실제 데이터·실명이 없고 서버·DB·Anthropic을 부르지 않는다. 공유 화면과 같은 SharedReport로 그린다(하이라이트 카드·ㅋ 유형·케미 온도·MBTI 포함).
// 검색에 남기지 않는다(robots noindex, next.config의 X-Robots-Tag). dev 미리보기(app/dev/preview) 코드에 기대지 않는다
import type { Metadata } from "next";
import Link from "next/link";
import { SharedReport, type SharedReportData } from "@/components/episode/SharedReport";
import { demoNames, demoReport, demoStats } from "@/lib/demo/report";

export const metadata: Metadata = {
  title: "데모 리포트 · analytalk",
  description: "가짜 대화로 만든 예시 리포트",
  robots: { index: false, follow: false },
};

const view: SharedReportData = { concept: "group", tone: "fact", displayNames: demoNames, stats: demoStats, report: demoReport };

export default function DemoPage() {
  return (
    <SharedReport
      view={view}
      notice={
        <div className="grid gap-1">
          <nav>
            <Link href="/" className="inline-flex min-h-11 items-center text-base text-ink-soft underline-offset-4 hover:underline">
              ← 처음 화면
            </Link>
          </nav>
          <p role="note" className="rounded-lg border border-dashed border-ink/25 bg-sheet/80 p-3 text-base">
            데모 리포트예요. 가짜 단톡방(민지·철수·영희·지훈·수아)으로 만든 예시라 실제 사람·대화가 아니에요.
          </p>
        </div>
      }
    />
  );
}
