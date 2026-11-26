// service_role(secret 키) Supabase 클라이언트. 앱의 DB 접근은 모두 이것으로만 한다.
// analytalk 테이블은 RLS를 켠 채 정책이 0개라 secret 키 말고는 읽지도 쓰지도 못한다.
// secret 키 클라이언트를 만드는 곳은 이 파일과 scripts/invite.ts뿐이다(test/boundaries.test.ts가 확인).
import "server-only";
import { createClient } from "@supabase/supabase-js";
import { APP_SCHEMA } from "@/lib/app";

/**
 * URL·secret 키가 없으면 null (getRepo가 개발은 memoryRepo, 프로덕션은 503으로 정한다).
 * env를 주면 process.env 대신 그 값을 쓴다(scripts의 --prod는 .env.production.local을 parseEnv로 읽어 넘긴다)
 */
export function privilegedDb(env: Record<string, string | undefined> = process.env) {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }).schema(APP_SCHEMA);
}

export type PrivilegedDb = NonNullable<ReturnType<typeof privilegedDb>>;
