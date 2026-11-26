import { handleRetry } from "@/lib/server/handlers/retry";
import { respond } from "@/lib/server/route";

// 다시 쓰는 리포트는 응답 뒤 after()에서 이 함수 호출 안에서 돈다(마감 270초)
export const maxDuration = 300;

// 리포트 [다시 쓰기] {id, payload} → 202 · 409 · 423 · 429 {reason}
export async function POST(request: Request) {
  return respond(request, handleRetry);
}
