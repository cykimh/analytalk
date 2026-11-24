import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EpisodeView } from "@/components/episode/EpisodeView";
import { AI_NOTICE } from "@/components/episode/model";
import { PageFrame } from "@/components/episode/PageState";
import { buttonVariants } from "@/components/ui/button";
import { loadSharedView } from "@/lib/server/handlers/shares";
import { getRepo } from "@/lib/server/repo";

// 캐시하지 않는다. 요청마다 공유 상태를 다시 읽어 폐기·범위 변경·삭제가 바로 반영된다
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ token: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { token } = await params;
  const view = await loadSharedView(getRepo(), token);
  const base: Metadata = { title: "공유된 연재 · analytalk", robots: { index: false, follow: false } };
  if (!view) return base;
  // OG 이미지는 컨셉별 고정 이미지다. 대화 내용·이름은 넣지 않는다
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  const image = host ? `${proto}://${host}/og/${view.concept}.png` : `/og/${view.concept}.png`;
  return {
    ...base,
    openGraph: { title: "analytalk 연재 리포트", description: AI_NOTICE, images: [{ url: image, width: 1200, height: 630, alt: AI_NOTICE }] },
    twitter: { card: "summary_large_image", images: [image] },
  };
}

export default async function SharedPage({ params }: Props) {
  const { token } = await params;
  const view = await loadSharedView(getRepo(), token);
  if (!view) notFound();

  return (
    <PageFrame>
      <header className="grid gap-1">
        <p className="text-xs text-muted-foreground">{AI_NOTICE}</p>
        <p className="text-sm break-words">{view.displayNames.join(" · ")}의 대화</p>
      </header>

      {view.episodes.length === 0 ? (
        <p className="rounded-xl border p-4 text-sm">보여 줄 편이 없어요.</p>
      ) : (
        view.episodes.map((e) => <EpisodeView key={e.n} n={e.n} content={e.content} stats={view.stats} />)
      )}

      <Link href="/" className={buttonVariants({ size: "lg" })}>
        나도 해보기
      </Link>
    </PageFrame>
  );
}
