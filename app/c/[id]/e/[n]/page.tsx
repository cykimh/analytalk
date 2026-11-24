import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { EpisodeReader } from "@/components/episode/EpisodeReader";
import { hasInvite } from "@/lib/server/viewer";

export const metadata: Metadata = { title: "연재 읽기 · analytalk" };

// 초대 코드 세션이 있어야 들어온다. 편 번호는 1~4만 있다
export default async function EpisodePage({ params }: { params: Promise<{ id: string; n: string }> }) {
  if (!(await hasInvite())) redirect("/");
  const { id, n } = await params;
  if (!/^[1-4]$/.test(n)) notFound();
  return <EpisodeReader id={id} n={Number(n)} />;
}
