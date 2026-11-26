import { handleFeedback } from "@/lib/server/handlers/feedback";
import { respond } from "@/lib/server/route";

// 리포트 문단의 [틀렸어요] {id, paragraphKey, reason}
export async function POST(request: Request) {
  return respond(request, handleFeedback);
}
