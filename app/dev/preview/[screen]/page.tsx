// dev 미리보기: 리포트 화면 하나를 가짜 데이터로 그린다. /dev/preview/home·episode·steps·share. 프로덕션은 404
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SharedReport } from "@/components/episode/SharedReport";
import { previewShared } from "../data";
import { devOnly } from "../gate";
import { PreviewNav } from "../PreviewNav";
import { PreviewScreen } from "./PreviewScreen";

export const metadata: Metadata = { title: "미리보기 · analytalk", robots: { index: false, follow: false } };

const SCREENS = ["home", "episode", "steps", "share"] as const;
type Screen = (typeof SCREENS)[number];
const isScreen = (s: string): s is Screen => (SCREENS as readonly string[]).includes(s);

export default async function PreviewScreenPage({ params }: { params: Promise<{ screen: string }> }) {
  devOnly();
  const { screen } = await params;
  if (!isScreen(screen)) notFound();
  return (
    <>
      <PreviewNav current={screen} />
      {screen === "share" ? <SharedReport view={previewShared} /> : <PreviewScreen screen={screen} />}
    </>
  );
}
