import { handleCreateShare, handleRevokeShare } from "@/lib/server/handlers/shares";
import { respond } from "@/lib/server/route";

// 공유 링크 만들기·범위 바꾸기 {id, scope, hidden} → {url}
export async function POST(request: Request) {
  return respond(request, handleCreateShare);
}

// 공유 링크 폐기 {id}
export async function DELETE(request: Request) {
  return respond(request, handleRevokeShare);
}
