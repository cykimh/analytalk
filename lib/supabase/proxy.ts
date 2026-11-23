import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// 매 요청마다 Auth 세션 쿠키를 갱신한다. 로그인 강제(리다이렉트)는 앱마다 필요할 때 여기에 추가한다.
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  // 환경 변수가 아직 없으면(첫 배포 등) 세션 갱신 없이 통과시킨다. 상태는 /api/health 가 알려준다.
  if (!url || !key) return response;

  const supabase = createServerClient(
    url,
    key,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  // getClaims() 를 지우면 SSR 에서 사용자가 무작위로 로그아웃될 수 있다 (Supabase 공식 경고).
  await supabase.auth.getClaims();

  return response;
}
