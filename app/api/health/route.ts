import { APP_SCHEMA } from "@/lib/app";
import { type AppRepo, getRepo, NotReadyError } from "@/lib/server/repo";

// 정적 최적화를 막아 매 요청이 함수로 실행되게 한다.
// 응답 헤더 x-vercel-id 와 본문 region 으로 함수 실행 리전(icn1)을 확인하는 용도 (sideinfra scripts/app.sh verify).
export const dynamic = "force-dynamic";

export async function GET() {
  const region = process.env.VERCEL_REGION ?? "local";
  let repo: AppRepo;
  try {
    repo = getRepo();
  } catch (error) {
    if (error instanceof NotReadyError) return Response.json({ app: APP_SCHEMA, region, db: "not_configured" }, { status: 503 });
    throw error;
  }

  const started = performance.now();
  const ok = await repo.ping();
  // 함수 → Supabase Data API → Postgres 왕복 시간. 클라이언트 쪽 네트워크 지연과 분리해서 본다.
  const dbMs = Math.round(performance.now() - started);

  return Response.json({ app: APP_SCHEMA, region, db: ok ? "ok" : "error", db_ms: dbMs }, { status: ok ? 200 : 503 });
}
