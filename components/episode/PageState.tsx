"use client";

// 대화 화면들이 아직 내용을 못 그릴 때: 불러오는 중·없음·세션 끝남·네트워크 오류
import Link from "next/link";
import type { ReactNode } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import type { LoadError } from "./useConversation";

const TEXT: Record<LoadError, string> = {
  unauthorized: "초대 코드 확인이 만료됐어요. 처음 화면에서 코드를 다시 넣어 주세요.",
  not_found: "대화를 찾을 수 없어요. 30일이 지나 지워졌거나, 삭제했거나, 다른 초대 코드로 만든 대화예요.",
  network: "대화를 불러오지 못했어요.",
};

export function PageFrame({ children }: { children: ReactNode }) {
  return <main className="mx-auto grid w-full max-w-2xl min-w-0 gap-6 px-4 py-8">{children}</main>;
}

/** error가 있으면 그 안내, 없으면 불러오는 중 */
export function PageState({ error, onReload }: { error: LoadError | null; onReload: () => void }) {
  if (!error) {
    return (
      <PageFrame>
        <p aria-busy className="text-sm text-muted-foreground">
          불러오는 중…
        </p>
      </PageFrame>
    );
  }
  return (
    <PageFrame>
      <div role="alert" className="grid gap-3 rounded-xl border p-4 text-sm">
        <p>{TEXT[error]}</p>
        <div className="flex flex-wrap gap-2">
          {error === "network" && (
            <Button size="sm" onClick={onReload}>
              다시 불러오기
            </Button>
          )}
          <Link href={error === "not_found" ? "/new" : "/"} className={buttonVariants({ size: "sm", variant: "outline" })}>
            {error === "not_found" ? "대화 올리기" : "처음 화면"}
          </Link>
        </div>
      </div>
    </PageFrame>
  );
}

/** 이 상태면 내용 대신 PageState를 그린다. 이미 그린 대화는 network 오류가 나도 그대로 둔다 */
export const blocking = (error: LoadError | null, loaded: boolean) =>
  error === "unauthorized" || error === "not_found" || !loaded;
