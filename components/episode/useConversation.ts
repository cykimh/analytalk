"use client";

// 대화 홈·진행·편 화면이 같이 쓰는 상태: 대화(편 내용 포함)를 읽고, 서버가 쓰는 편이 있는 동안 POLL_MS마다 status를 폴링한다.
// 탭을 닫았다 다시 열어도 서버에서 편이 계속 진행되므로, 화면은 열릴 때마다 API에서 상태를 다시 불러온다.
// 편 상태가 바뀌면 대화를 다시 읽어 끝난 편의 내용을 받는다. 다시 쓸 편이 없으면 이 브라우저의 페이로드를 지운다.
import { useCallback, useEffect, useRef, useState } from "react";
import { deletePayload, loadPayload, sweepPayloads } from "@/lib/client/idb";
import { forgetSeries } from "@/lib/client/recent";
import { postJson, retryEpisode, type SubmitResult } from "@/lib/client/submit";
import { POLL_MS } from "@/lib/config";
import { type ConversationView, isActive, isSettled, mergeEpisodeNotes, type Note, statusChanged, type StatusView } from "./model";

/** unauthorized·not_found는 더 읽지 않는다. network는 다시 시도한다 */
export type LoadError = "unauthorized" | "not_found" | "network";

type Got<T> = { ok: true; body: T } | { ok: false; error: LoadError };

async function getJson<T>(url: string): Promise<Got<T>> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (res.status === 401) return { ok: false, error: "unauthorized" };
    if (res.status === 404) return { ok: false, error: "not_found" };
    if (!res.ok) return { ok: false, error: "network" };
    return { ok: true, body: (await res.json()) as T };
  } catch {
    return { ok: false, error: "network" };
  }
}

export function useConversation(id: string) {
  const base = `/api/conversations/${encodeURIComponent(id)}`;
  const [conversation, setConversation] = useState<ConversationView | null>(null);
  const [status, setStatus] = useState<StatusView | null>(null);
  const [notes, setNotes] = useState<Record<number, Note[]>>({});
  const [error, setError] = useState<LoadError | null>(null);
  /** status를 읽은 횟수(실패 포함). 바뀔 때마다 다음 폴링을 건다 */
  const [polls, setPolls] = useState(0);
  /** 이 status 때문에 대화를 이미 다시 읽었다(status 하나에 한 번만 다시 읽는다) */
  const syncedFor = useRef<StatusView | null>(null);

  const loadConversation = useCallback(async () => {
    const r = await getJson<ConversationView>(base);
    if (r.ok) {
      setConversation(r.body);
      setError(null);
    } else {
      setError(r.error);
    }
  }, [base]);

  const loadStatus = useCallback(async () => {
    const r = await getJson<StatusView>(`${base}/status`);
    if (r.ok) {
      setStatus(r.body);
      setNotes((prev) => mergeEpisodeNotes(prev, r.body.episodes));
    } else if (r.error !== "network") {
      setError(r.error);
    }
    setPolls((p) => p + 1);
  }, [base]);

  useEffect(() => {
    void sweepPayloads().catch(() => undefined);
    void loadConversation();
    void loadStatus();
  }, [loadConversation, loadStatus]);

  // 첫 status를 받을 때까지, 그 뒤로는 서버가 쓰는 편이 있는 동안 폴링한다
  const fatal = error === "unauthorized" || error === "not_found";
  const active = status === null || isActive(status.episodes);
  useEffect(() => {
    if (fatal || !active) return;
    const timer = setTimeout(() => void loadStatus(), POLL_MS);
    return () => clearTimeout(timer);
  }, [fatal, active, polls, loadStatus]);

  useEffect(() => {
    if (!conversation || !status || syncedFor.current === status) return;
    if (statusChanged(conversation.episodes, status.episodes)) {
      syncedFor.current = status;
      void loadConversation();
    }
  }, [conversation, status, loadConversation]);

  useEffect(() => {
    if (conversation && isSettled(conversation.episodes)) void deletePayload(id).catch(() => undefined);
  }, [conversation, id]);

  // 지워졌거나 만료된 대화는 시작 화면의 '내 연재'에서 뺀다
  useEffect(() => {
    if (error === "not_found") forgetSeries(id);
  }, [error, id]);

  /** [다시 쓰기]. 받아 주면 바로 status를 다시 읽어 폴링을 잇는다 */
  const retry = useCallback(
    async (n: number): Promise<SubmitResult> => {
      const r = await retryEpisode(id, n, { load: loadPayload, post: postJson("/api/episodes/retry") });
      if (r.ok) await loadStatus();
      return r;
    },
    [id, loadStatus],
  );

  return { conversation, status, notes, error, retry, reload: loadConversation };
}
