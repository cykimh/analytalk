"use client";

// /c/[id] 대화 홈: 읽은 범위·삭제 예정일 → 4편 카드([읽기]·[다시 쓰기]) → 통계 → [지금 삭제].
// 탭을 다시 열어도 API에서 상태를 불러오고, 쓰는 편이 있으면 폴링해 끝난 편부터 연다.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { StatsDashboard } from "@/components/stats/StatsDashboard";
import { Button, buttonVariants } from "@/components/ui/button";
import { deletePayload } from "@/lib/client/idb";
import type { SubmitResult } from "@/lib/client/submit";
import { hasStatText } from "@/lib/episode/statText";
import type { StoredEpisode } from "@/lib/llm/schema";
import type { ChatStats } from "@/lib/stats/compute";
import { AI_NOTICE, episodeAction, kstDay, PAUSED_TEXT, readRange, SAFETY_HELP, STATUS_TEXT } from "./model";
import { blocking, PageFrame, PageState } from "./PageState";
import { StatText } from "./StatText";
import { useConversation } from "./useConversation";

function EpisodeCard({
  id,
  n,
  status,
  content,
  stats,
  paused,
  onRetry,
}: {
  id: string;
  n: number;
  status: string;
  content: StoredEpisode | null;
  stats: ChatStats;
  paused: boolean;
  onRetry: (n: number) => Promise<SubmitResult>;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const action = episodeAction(status, paused);

  async function retry() {
    setBusy(true);
    setMessage(null);
    const r = await onRetry(n);
    if (!r.ok) setMessage(r.message);
    setBusy(false);
  }

  return (
    <section aria-label={`${n}편`} className="grid min-w-0 content-start gap-2 rounded-xl border p-4">
      <p className="text-xs text-muted-foreground">
        {n}편 · {STATUS_TEXT[status] ?? status}
      </p>
      {content && (
        <h3 className="font-semibold break-words">
          {hasStatText(content.headline, stats) ? <StatText text={content.headline} stats={stats} /> : `${n}편`}
        </h3>
      )}
      {status === "safety" && <p className="text-sm">{SAFETY_HELP}</p>}
      {(action.read || action.retry) && (
        <div className="flex flex-wrap items-center gap-2">
          {action.read && (
            <Link href={`/c/${id}/e/${n}`} className={buttonVariants({ size: "sm" })}>
              {n}편 읽기
            </Link>
          )}
          {action.retry === "button" && (
            <Button size="sm" variant="outline" disabled={busy} onClick={retry}>
              다시 쓰기
            </Button>
          )}
          {action.retry === "paused" && <span className="text-xs text-muted-foreground">{PAUSED_TEXT}</span>}
        </div>
      )}
      {message && (
        <p role="alert" className="text-xs text-destructive">
          {message}
        </p>
      )}
    </section>
  );
}

/** [지금 삭제] → 한 번 더 묻고 DELETE. 이 브라우저의 페이로드도 지운다 */
function DeleteBox({ id }: { id: string }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
      // 404: 이미 지워졌거나 만료됐다
      if (res.status === 204 || res.status === 404) {
        await deletePayload(id).catch(() => undefined);
        router.replace("/");
        return;
      }
    } catch {
      // 아래 문구
    }
    setError("지우지 못했어요. 잠시 뒤 다시 시도해 주세요.");
    setBusy(false);
  }

  return (
    <section aria-labelledby="delete-title" className="grid gap-2 rounded-xl border p-4">
      <h2 id="delete-title" className="text-sm font-semibold">
        대화 지우기
      </h2>
      <p className="text-sm text-muted-foreground">4편과 통계, 이 대화로 남긴 피드백이 모두 지워지고 되돌릴 수 없어요.</p>
      {asking ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="destructive" disabled={busy} onClick={remove}>
            정말 지우기
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setAsking(false)}>
            취소
          </Button>
        </div>
      ) : (
        <Button variant="destructive" className="justify-self-start" onClick={() => setAsking(true)}>
          지금 삭제
        </Button>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

export function ConversationHome({ id }: { id: string }) {
  const { conversation, status, error, retry, reload } = useConversation(id);
  if (blocking(error, conversation !== null)) return <PageState error={error} onReload={reload} />;
  const c = conversation!;
  const paused = status?.paused ?? false;

  return (
    <PageFrame>
      <header className="grid gap-2">
        <p className="text-xs text-muted-foreground">{AI_NOTICE}</p>
        <h1 className="text-xl font-semibold">{c.concept === "couple" ? "둘의 대화 연재" : "단톡방 연재"}</h1>
        <p className="truncate text-sm text-muted-foreground">{c.displayNames.join(", ")}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">읽은 범위</dt>
          <dd>{readRange(c.cutoffAt, c.msgSent)}</dd>
          <dt className="text-muted-foreground">삭제 예정일</dt>
          <dd>{kstDay(c.expiresAt)} (30일 보관)</dd>
        </dl>
      </header>

      <section aria-labelledby="episodes-title" className="grid gap-3">
        <h2 id="episodes-title" className="text-sm font-semibold">
          연재 4편
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {c.episodes.map((e) => (
            <EpisodeCard
              key={e.n}
              id={id}
              n={e.n}
              status={status?.episodes.find((s) => s.n === e.n)?.status ?? e.status}
              content={e.content}
              stats={c.stats}
              paused={paused}
              onRetry={retry}
            />
          ))}
        </div>
      </section>

      <section aria-labelledby="stats-title" className="grid gap-3">
        <h2 id="stats-title" className="text-sm font-semibold">
          대화 통계
        </h2>
        <StatsDashboard stats={c.stats} kind={c.kind} me="" />
      </section>

      <DeleteBox id={id} />
    </PageFrame>
  );
}
