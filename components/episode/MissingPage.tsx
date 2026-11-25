// 없는 주소·사라진 공유 링크(404) 화면. 리포트 화면과 같은 430px 다이어리 한 장에
// 사진을 떼어 낸 빈자리(점선 테두리 + 남은 테이프) → 제목·설명 종이 → [처음 화면으로] 순서로 둔다.
// 훅이 없어 서버 컴포넌트(not-found.tsx)에서 그린다
import Link from "next/link";
import type { ReactNode } from "react";
import { Highlight } from "@/components/scrap/Highlight";
import { MaskingTape } from "@/components/scrap/MaskingTape";
import { Paper } from "@/components/scrap/Paper";
import { tapeAt } from "@/components/scrap/tilt";
import { buttonVariants } from "@/components/ui/button";
import { PageFrame } from "./PageState";

export function MissingPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <PageFrame>
      {/* 장식: 붙여 둔 사진을 떼어 내고 테이프만 남은 자리 */}
      <div
        aria-hidden
        className="relative mt-3 grid aspect-[4/3] w-52 -rotate-2 place-items-center justify-self-center rounded-[2px] border-2 border-dashed border-ink/20 bg-sheet/50"
      >
        <MaskingTape color="pink" at="left" />
        <MaskingTape color="sky" at="right" />
        <span className="text-base text-ink-soft">빈자리</span>
      </div>

      <Paper as="header" tilt="right" tape={tapeAt(2)} className="grid gap-3 px-5 pt-7 pb-6">
        <h1 className="text-[1.75rem] leading-tight font-bold tracking-tight">
          <Highlight>{title}</Highlight>
        </h1>
        <div className="grid gap-2 text-base leading-relaxed">{children}</div>
      </Paper>

      <Link href="/" className={buttonVariants({ size: "lg" })}>
        처음 화면으로
      </Link>
    </PageFrame>
  );
}
