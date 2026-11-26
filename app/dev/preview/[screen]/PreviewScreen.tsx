"use client";

// dev 미리보기의 대화 화면들. 진짜 화면 컴포넌트(…View)에 가짜 데이터와 아무것도 하지 않는 핸들러를 넣는다
import { ConversationHomeView } from "@/components/episode/ConversationHome";
import { ReportReaderView } from "@/components/episode/ReportReader";
import type { SubmitResult } from "@/lib/client/submit";
import { PREVIEW_ID, previewConversation, previewNotes, previewReadyConversation, previewStatus } from "../data";

const noRetry = async (): Promise<SubmitResult> => ({ ok: false, message: "미리보기에서는 다시 쓰지 않아요." });
const noReload = async () => undefined;

export function PreviewScreen({ screen }: { screen: "home" | "report" }) {
  if (screen === "home") {
    return <ConversationHomeView id={PREVIEW_ID} conversation={previewConversation} status={previewStatus} notes={previewNotes} retry={noRetry} reload={noReload} />;
  }
  return <ReportReaderView id={PREVIEW_ID} conversation={previewReadyConversation} />;
}
