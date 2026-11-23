import { createClient } from "@/lib/supabase/server";
import { APP_SCHEMA } from "@/lib/app";

// 정적 최적화를 막아 매 요청이 함수로 실행되게 한다.
// 응답 헤더 x-vercel-id 와 본문 region 으로 함수 실행 리전(icn1)을 확인하는 용도.
export const dynamic = "force-dynamic";

export async function GET() {
  const region = process.env.VERCEL_REGION ?? "local";
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
    return Response.json({ app: APP_SCHEMA, region, db: "not_configured" }, { status: 503 });
  }

  const supabase = await createClient();
  const started = performance.now();
  const { data, error } = await supabase.rpc("healthcheck");
  // 함수 → Supabase Data API → Postgres 왕복 시간. 클라이언트 쪽 네트워크 지연과 분리해서 본다.
  const dbMs = Math.round(performance.now() - started);
  const ok = !error && data === "ok";

  return Response.json(
    { app: APP_SCHEMA, region, db: ok ? "ok" : (error?.code ?? "unexpected"), db_ms: dbMs },
    { status: ok ? 200 : 503 },
  );
}
