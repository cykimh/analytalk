import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { APP_SCHEMA } from "@/lib/app";

export default function Home() {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{APP_SCHEMA}</CardTitle>
          <CardDescription>sideinfra 템플릿에서 만든 앱입니다.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Next.js · Supabase · Tailwind CSS · shadcn/ui
        </CardContent>
        <CardFooter>
          <Link href="/api/health" className={buttonVariants({ variant: "outline" })}>
            상태 확인
          </Link>
        </CardFooter>
      </Card>
    </main>
  );
}
