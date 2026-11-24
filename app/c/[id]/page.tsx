import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ConversationHome } from "@/components/episode/ConversationHome";
import { hasInvite } from "@/lib/server/viewer";

export const metadata: Metadata = { title: "대화 홈 · analytalk" };

// 초대 코드 세션이 있어야 들어온다. 대화·편 상태는 화면이 API에서 읽는다(같은 코드로 만든 대화만)
export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await hasInvite())) redirect("/");
  const { id } = await params;
  return <ConversationHome id={id} />;
}
