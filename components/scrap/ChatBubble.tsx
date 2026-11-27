// 근거 인용 말풍선(v2.3, 2026-11-27 사용자: "실제 메시지 포스트잇처럼 되어 있는 문장은 그냥 카톡 메시지 모양처럼").
// 카카오톡 대화방의 상대 말풍선처럼: 위에 보낸 사람 이름(작게) → 그 아래 흰 말풍선(둥근 모서리, 왼쪽 위 꼬리) → 말풍선 옆 아래에 시각(작게, tabular).
// 노란 내 말풍선은 쓰지 않는다(리포트는 방 밖에서 본 것이라 모두 상대 말풍선이다). 여러 개가 이어지면 ChatRoom 안에 대화처럼 쌓인다.
// 읽는 순서는 이름 → 본문 → 시각이다(figcaption은 figure의 첫 자식이어야 해서 이름만 캡션으로 둔다).
// 카톡 인용에는 띄어 쓰지 않은 긴 ㅋ 줄·붙여 쓴 문장이 흔하다: figure는 grid-cols-1(minmax(0,1fr))로 칸 폭을 부모에 묶고,
// 말풍선은 min-w-0 + wrap-anywhere로 줄을 바꾼다. 시각은 shrink-0이라 말풍선이 줄어든다
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function ChatBubble({
  sender,
  time,
  dateTime,
  children,
  className,
}: {
  /** 보낸 사람 표시 이름 */
  sender: ReactNode;
  /** 화면에 보이는 시각. 두 줄(날짜 · 시각)이면 배열로 준다 */
  time: readonly string[];
  /** <time dateTime> 값(ISO) */
  dateTime: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <figure className={cn("grid min-w-0 grid-cols-1 justify-items-start gap-1", className)}>
      <figcaption className="max-w-full pl-1 text-[0.8125rem] leading-5 text-ink wrap-anywhere">{sender}</figcaption>
      <div className="flex min-w-0 max-w-full items-end gap-1.5 pl-1.5">
        <blockquote className="bubble min-w-0 px-3 py-2 text-base leading-6 wrap-anywhere whitespace-pre-wrap">{children}</blockquote>
        {time.length > 0 && (
          <time dateTime={dateTime} className="shrink-0 pb-0.5 text-xs leading-4 whitespace-nowrap text-ink-soft tabular-nums">
            {time.map((t, i) => (
              <span key={t} className="block">
                {i > 0 ? " " : ""}
                {t}
              </span>
            ))}
          </time>
        )}
      </div>
    </figure>
  );
}

/** 말풍선을 쌓는 대화방 바탕. 흰 카드 위에서 흰 말풍선이 보이게 옅은 회색 판을 깐다 */
export function ChatRoom({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("chat-room grid min-w-0 grid-cols-1 gap-3 rounded-xl px-3 py-3.5", className)}>{children}</div>;
}
