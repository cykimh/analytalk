import { handleInternalEpisode } from "@/lib/server/handlers/internal";
import { respond } from "@/lib/server/route";

// 2~4편은 각자 이 함수 호출 안에서 after()로 돈다(편당 마감 270초)
export const maxDuration = 300;

// 1편 작업이 서명해서 보낸 2~4편. 서명이 맞지 않으면 404
export async function POST(request: Request) {
  return respond(request, handleInternalEpisode);
}
