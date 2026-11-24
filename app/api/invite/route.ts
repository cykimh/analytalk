import { handleInvite } from "@/lib/server/handlers/invite";
import { respond } from "@/lib/server/route";

// 초대 코드 + Turnstile 토큰 → 30일 세션 쿠키
export async function POST(request: Request) {
  return respond(request, handleInvite);
}
