"use client";

// 문단 [틀렸어요] → 이유 고르기 → POST /api/feedback {id, paragraphKey, reason}. 문단 글은 보내지 않는다
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { postJson } from "@/lib/client/submit";
import { FEEDBACK_LABEL, FEEDBACK_REASONS, type FeedbackReason } from "@/lib/episode/feedback";

const send = postJson("/api/feedback");

/** describedBy: 어느 문단인지 알려 주는 요소의 id(버튼 설명) */
export function FeedbackButton({ id, paragraphKey, describedBy }: { id: string; paragraphKey: string; describedBy?: string }) {
  const [state, setState] = useState<"idle" | "choosing" | "sending" | "sent" | "error">("idle");

  async function choose(reason: FeedbackReason) {
    setState("sending");
    try {
      const res = await send({ id, paragraphKey, reason });
      setState(res.ok ? "sent" : "error");
    } catch {
      setState("error");
    }
  }

  if (state === "sent") {
    return (
      <p role="status" className="py-2.5 text-base text-muted-foreground">
        알려 줘서 고마워요
      </p>
    );
  }
  if (state === "idle") {
    return (
      <Button
        variant="ghost"
        className="-ml-2 justify-self-start px-2 text-muted-foreground"
        aria-describedby={describedBy}
        onClick={() => setState("choosing")}
      >
        틀렸어요
      </Button>
    );
  }
  return (
    <div role="group" aria-label="무엇이 틀렸나요?" className="flex flex-wrap items-center gap-2">
      {FEEDBACK_REASONS.map((reason) => (
        <Button key={reason} variant="outline" disabled={state === "sending"} onClick={() => choose(reason)}>
          {FEEDBACK_LABEL[reason]}
        </Button>
      ))}
      <Button variant="ghost" disabled={state === "sending"} onClick={() => setState("idle")}>
        취소
      </Button>
      {state === "error" && (
        <p role="alert" className="w-full text-base text-destructive">
          보내지 못했어요. 다시 눌러 주세요.
        </p>
      )}
    </div>
  );
}
