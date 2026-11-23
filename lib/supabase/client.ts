import { createBrowserClient } from "@supabase/ssr";
import { APP_SCHEMA } from "@/lib/app";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { db: { schema: APP_SCHEMA } },
  );
}
