import { headers } from "next/headers";
import Link from "next/link";
import { InAppBanner } from "@/components/upload/InAppBanner";
import { InviteForm } from "@/components/upload/InviteForm";
import { RecentSeries } from "@/components/upload/RecentSeries";
import { buttonVariants } from "@/components/ui/button";
import { isKakaoInApp } from "@/lib/client/inapp";
import { hasInvite } from "@/lib/server/viewer";

// 쿠키가 없으면 초대 코드, 있으면 [대화 올리기]와 이 브라우저에서 만든 연재 목록
export default async function Home() {
  const [invited, ua] = await Promise.all([hasInvite(), headers().then((h) => h.get("user-agent") ?? "")]);
  return (
    <main className="mx-auto grid min-h-svh w-full max-w-md content-center gap-6 px-4 py-10">
      <header className="grid gap-2">
        <h1 className="text-[2rem] leading-tight font-bold tracking-tight">analytalk</h1>
        <p className="text-base leading-relaxed text-muted-foreground">
          카톡 대화를 브라우저 안에서 읽어 통계를 보여 주고, 원하면 AI가 리포트로 써 드려요. 지인 초대로만 써요.
        </p>
      </header>
      {isKakaoInApp(ua) && <InAppBanner />}
      {invited ? (
        <>
          <section className="paper-sheet grid gap-3 bg-sheet p-5">
            <Link href="/new" className={buttonVariants({ size: "lg" })}>
              대화 올리기
            </Link>
          </section>
          <RecentSeries />
        </>
      ) : (
        <section className="paper-sheet grid gap-3 bg-sheet p-5">
          <InviteForm />
        </section>
      )}
      <Link
        href="/about"
        className="inline-flex min-h-11 items-center justify-self-center text-base text-muted-foreground underline underline-offset-4"
      >
        무엇이 어디로 가나요?
      </Link>
    </main>
  );
}
