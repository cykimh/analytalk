import { handleCreateShare, handleRevokeShare } from "@/lib/server/handlers/shares";
import { respond } from "@/lib/server/route";

// 공유 링크 만들기 {id} → {url, shared: true}. 이미 공유 중이면 {url: null, shared: true}
export async function POST(request: Request) {
  return respond(request, handleCreateShare);
}

// 공유 링크 폐기 {id}
export async function DELETE(request: Request) {
  return respond(request, handleRevokeShare);
}
