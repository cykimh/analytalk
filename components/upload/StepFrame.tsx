"use client";

// 업로드 흐름 한 단계의 틀: 제목(단계가 바뀌면 포커스) → 내용 → [이전]·[다음].
// busy(Worker가 이름을 바꾸거나 페이로드를 만드는 중)이면 [이전]을 막는다: 앞 단계에서 값을 바꾸면 끝난 작업이 옛 값으로 덮는다
import { type ReactNode, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";

export function StepFrame({
  title,
  description,
  children,
  onBack,
  action,
  busy = false,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  onBack?: () => void;
  action?: ReactNode;
  busy?: boolean;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);

  return (
    <section aria-labelledby="step-title" className="grid min-w-0 gap-5">
      <header className="grid gap-1">
        <h2 id="step-title" ref={heading} tabIndex={-1} className="font-hand text-[1.75rem] leading-tight font-bold outline-none">
          {title}
        </h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </header>
      {children}
      {(onBack || action) && (
        <footer className="flex flex-wrap items-center justify-between gap-2">
          {onBack ? (
            <Button variant="ghost" size="lg" onClick={onBack} disabled={busy}>
              이전
            </Button>
          ) : (
            <span />
          )}
          {action}
        </footer>
      )}
    </section>
  );
}

/** [다음]. 막힌 이유 문구가 있으면 describedBy로 버튼 설명에 묶는다 */
export function NextButton({ onClick, disabled, describedBy }: { onClick: () => void; disabled?: boolean; describedBy?: string }) {
  return (
    <Button size="lg" onClick={onClick} disabled={disabled} aria-describedby={describedBy}>
      다음
    </Button>
  );
}
