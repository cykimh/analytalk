import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { StepsFeed } from "@/components/episode/StepsFeed";
import { hasInvite } from "@/lib/server/viewer";

export const metadata: Metadata = { title: "AI가 읽는 중 · analytalk" };

// 초대 코드 세션이 있어야 들어온다. 진행 상황은 화면이 status API를 폴링해 읽는다
export default async function StepsPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await hasInvite())) redirect("/");
  const { id } = await params;
  return <StepsFeed id={id} />;
}
