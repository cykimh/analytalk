import { handleDeleteConversation, handleGetConversation } from "@/lib/server/handlers/conversation";
import { respond } from "@/lib/server/route";

type Context = { params: Promise<{ id: string }> };

// 대화 홈·편 화면이 읽는 대화와 편 내용
export async function GET(request: Request, { params }: Context) {
  const { id } = await params;
  return respond(request, (req, deps) => handleGetConversation(req, deps, id));
}

// [지금 삭제]
export async function DELETE(request: Request, { params }: Context) {
  const { id } = await params;
  return respond(request, (req, deps) => handleDeleteConversation(req, deps, id));
}
