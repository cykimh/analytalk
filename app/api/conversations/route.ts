import { handleCreateConversation } from "@/lib/server/handlers/conversations";
import { respond } from "@/lib/server/route";

// 리포트는 응답 뒤 after()에서 이 함수 호출 안에서 한 번 돈다(마감 270초)
export const maxDuration = 300;

// 페이로드 → 202 {id}(새 리포트) · 200 {id}(중복) · 413 {maxTokens} · 423 · 429 {reason}
export async function POST(request: Request) {
  return respond(request, handleCreateConversation);
}
