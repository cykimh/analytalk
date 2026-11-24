// 모델이 쓴 글 한 덩이(헤드라인·dek·섹션 제목·문단·예고·진행 메모)를 그린다.
// {{stat:경로}}는 통계 값으로 채우고 풀리지 않는 것은 뺀다. 글은 React 텍스트 노드로만 그린다.
// 훅이 없어 서버·클라이언트 컴포넌트 어디서나 쓴다(공유 화면 포함)
import { Fragment } from "react";
import { renderStatText } from "@/lib/episode/statText";
import type { ChatStats } from "@/lib/stats/compute";

export function StatText({ text, stats }: { text: string; stats: ChatStats }) {
  return renderStatText(text, stats).map((t, i) =>
    typeof t === "string" ? (
      <Fragment key={i}>{t}</Fragment>
    ) : (
      <strong key={i} className="font-semibold tabular-nums">
        {t.display}
      </strong>
    ),
  );
}
