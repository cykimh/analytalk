// 페이지(서버 컴포넌트)에서 지금 요청의 초대 코드 세션을 확인한다. API의 requireInvite와 같은 판정(서명·만료·폐기)이다.
import "server-only";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/config";
import { requireInvite } from "./handlers/invite";
import { getRepo, NotReadyError } from "./repo";
import { routeConfig } from "./route";

/** 유효한 세션이면 true. DB가 준비되지 않았으면(프로덕션에 키 없음) false로 보고 초대 코드 화면을 보여 준다 */
export async function hasInvite(): Promise<boolean> {
  const value = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!value) return false;
  let repo;
  try {
    repo = getRepo();
  } catch (error) {
    if (error instanceof NotReadyError) return false;
    throw error;
  }
  const req = new Request("http://localhost/", { headers: { cookie: `${SESSION_COOKIE}=${value}` } });
  const result = await requireInvite(req, { repo, secrets: routeConfig().secrets, now: () => Date.now() });
  return "inviteId" in result;
}
