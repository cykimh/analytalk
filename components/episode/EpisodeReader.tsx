"use client";

// /c/[id]/e/[n]: 검증을 통과해 저장된 편을 읽는다. 아직 쓰는 중이면 진행 화면으로, 못 쓴 편은 대화 홈으로 안내한다.
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { EpisodeView } from "./EpisodeView";
import { SAFETY_HELP, STATUS_TEXT } from "./model";
import { blocking, PageFrame, PageState } from "./PageState";
import { useConversation } from "./useConversation";

export function EpisodeReader({ id, n }: { id: string; n: number }) {
  const { conversation, error, reload } = useConversation(id);
  if (blocking(error, conversation !== null)) return <PageState error={error} onReload={reload} />;
  const episode = conversation!.episodes.find((e) => e.n === n);
  const next = conversation!.episodes.find((e) => e.n === n + 1);
  const status = episode?.status;

  return (
    <PageFrame>
      <nav>
        <Link href={`/c/${id}`} className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          ← 대화 홈
        </Link>
      </nav>

      {episode?.content ? (
        <>
          {status === "partial" && (
            <p role="note" className="rounded-xl border p-3 text-sm">
              일부 문단만 남았어요. 대화 홈에서 [다시 쓰기]로 다시 쓸 수 있어요.
            </p>
          )}
          <EpisodeView n={n} content={episode.content} stats={conversation!.stats} feedback={{ id }} />
        </>
      ) : (
        <div className="grid gap-3 rounded-xl border p-4 text-sm">
          <p className="font-semibold">
            {n}편 · {STATUS_TEXT[status ?? ""] ?? "아직 없어요"}
          </p>
          {status === "safety" && <p>{SAFETY_HELP}</p>}
          {(status === "queued" || status === "running") && (
            <Link href={`/c/${id}/steps`} className={buttonVariants({ size: "sm", variant: "outline" })}>
              진행 상황 보기
            </Link>
          )}
        </div>
      )}

      {next?.content && (
        <Link href={`/c/${id}/e/${n + 1}`} className={buttonVariants({ size: "lg" })}>
          {n + 1}편 읽기
        </Link>
      )}
    </PageFrame>
  );
}
