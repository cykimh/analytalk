// 근거 인용: 카톡 말풍선(ChatBubble)에 보낸 사람 표시 이름 → 인용 → 시각(KST, 날짜 · 시각 두 줄).
// 인용은 검증을 통과한 글자 그대로이고 React 텍스트 노드로만 그린다. 여러 개는 ChatRoom 안에 쌓는다
import { ChatBubble } from "@/components/scrap/ChatBubble";
import { formatAt } from "./model";

export function Evidence({ sender, at, quote }: { sender: string; at: string; quote: string }) {
  // formatAt: "YYYY-MM-DD HH:mm"(못 읽으면 빈 글자). 말풍선 옆에는 날짜와 시각을 두 줄로
  const time = formatAt(at).split(" ").filter(Boolean);
  return (
    <ChatBubble sender={sender} time={time} dateTime={at}>
      {quote}
    </ChatBubble>
  );
}
