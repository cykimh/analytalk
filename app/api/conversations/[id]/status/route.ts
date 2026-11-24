import { handleStatus } from "@/lib/server/handlers/status";
import { respond } from "@/lib/server/route";

// 진행 화면이 POLL_MS마다 읽는 편 상태와 진행 메모
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return respond(request, (req, deps) => handleStatus(req, deps, id));
}
