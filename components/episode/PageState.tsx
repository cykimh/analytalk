"use client";

// 리포트 화면(대화 홈·편·진행·공유)의 틀과, 아직 내용을 못 그릴 때: 불러오는 중·없음·세션 끝남·네트워크 오류.
// 틀은 430px 다이어리 한 장이다(DESIGN.md). 기운 카드·테이프가 옆으로 삐져나와도 가로 스크롤이 생기지 않게 가로만 자른다.
// 잘라 내서 안에서 넘친 글은 문서 가로 스크롤로 드러나지 않는다. 그래서 틀과 캡처 영역은 grid-cols-1로 카드 폭을 틀 폭에 묶고,
// e2e(expectNoHorizontalScroll)는 main의 넘침과 글자 위치까지 본다.
// 숫자(통계·날짜·시각)가 많은 화면이라 틀 전체에 tabular-nums를 준다
import Link from "next/link";
import type { ReactNode } from "react";
import { Paper } from "@/components/scrap/Paper";
import { tapeAt } from "@/components/scrap/tilt";
import { Button, buttonVariants } from "@/components/ui/button";
import type { LoadError } from "./useConversation";

const TEXT: Record<LoadError, string> = {
  unauthorized: "초대 코드 확인이 만료됐어요. 처음 화면에서 코드를 다시 넣어 주세요.",
  not_found: "대화를 찾을 수 없어요. 30일이 지나 지워졌거나, 삭제했거나, 다른 초대 코드로 만든 대화예요.",
  network: "대화를 불러오지 못했어요.",
};

export function PageFrame({ children }: { children: ReactNode }) {
  return <main className="mx-auto grid w-full max-w-[430px] min-w-0 grid-cols-1 gap-7 overflow-x-clip px-4 pt-8 pb-16 tabular-nums">{children}</main>;
}

/** 이미지로 저장할 리포트 영역의 id(저장 기능은 아직 없다). 한 화면에 하나 */
export const REPORT_CAPTURE_ID = "report-capture";

/**
 * 읽는 리포트(제목 → 본문 → 근거 인용)를 감싼다. 공유 패널·조작 버튼(다시 쓰기·피드백·삭제·공유)은 이 바깥 아래에 둔다.
 * 위아래 여백은 테이프가 잘리지 않게 둔다
 */
export function ReportCapture({ children }: { children: ReactNode }) {
  return (
    <div id={REPORT_CAPTURE_ID} className="grid min-w-0 grid-cols-1 gap-7 py-2">
      {children}
    </div>
  );
}

/** error가 있으면 그 안내, 없으면 불러오는 중 */
export function PageState({ error, onReload }: { error: LoadError | null; onReload: () => void }) {
  if (!error) {
    return (
      <PageFrame>
        <p aria-busy className="font-hand text-xl text-ink-soft">
          불러오는 중…
        </p>
      </PageFrame>
    );
  }
  return (
    <PageFrame>
      <Paper role="alert" tilt="left" calm tape={tapeAt(0)} className="grid gap-3 pt-6 text-base">
        <p>{TEXT[error]}</p>
        <div className="flex flex-wrap gap-2">
          {error === "network" && (
            <Button onClick={onReload}>
              다시 불러오기
            </Button>
          )}
          <Link href={error === "not_found" ? "/new" : "/"} className={buttonVariants({ variant: "outline" })}>
            {error === "not_found" ? "대화 올리기" : "처음 화면"}
          </Link>
        </div>
      </Paper>
    </PageFrame>
  );
}

/** 이 상태면 내용 대신 PageState를 그린다. 이미 그린 대화는 network 오류가 나도 그대로 둔다 */
export const blocking = (error: LoadError | null, loaded: boolean) =>
  error === "unauthorized" || error === "not_found" || !loaded;
