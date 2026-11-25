"use client";

// dev 미리보기의 대화 화면들. 진짜 화면 컴포넌트(…View)에 가짜 데이터와 아무것도 하지 않는 핸들러를 넣는다
import { ConversationHomeView } from "@/components/episode/ConversationHome";
import { EpisodeReaderView } from "@/components/episode/EpisodeReader";
import { StepsFeedView } from "@/components/episode/StepsFeed";
import type { SubmitResult } from "@/lib/client/submit";
import { PREVIEW_ID, previewConversation, previewNotes, previewStatus } from "../data";

const noRetry = async (): Promise<SubmitResult> => ({ ok: false, message: "미리보기에서는 다시 쓰지 않아요." });
const noReload = async () => undefined;

export function PreviewScreen({ screen }: { screen: "home" | "episode" | "steps" }) {
  if (screen === "home") {
    return <ConversationHomeView id={PREVIEW_ID} conversation={previewConversation} status={previewStatus} retry={noRetry} reload={noReload} />;
  }
  if (screen === "episode") return <EpisodeReaderView id={PREVIEW_ID} n={1} conversation={previewConversation} />;
  return <StepsFeedView id={PREVIEW_ID} conversation={previewConversation} status={previewStatus} notes={previewNotes} />;
}
