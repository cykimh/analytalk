"use client";

// "나는 누구?": 업로더 본인을 반드시 고른다
import { formatCount } from "@/components/stats/format";
import { NextButton, StepFrame } from "./StepFrame";

export function MeStep({
  participants,
  counts,
  me,
  onMe,
  onBack,
  onNext,
}: {
  participants: string[];
  counts: Record<string, number>;
  me: string | null;
  onMe: (name: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <StepFrame
      title="나는 누구?"
      description="이 대화를 내보낸 본인을 골라 주세요. 나를 표시하는 데만 써요. 리포트는 방 전체를 3인칭으로 써요."
      onBack={onBack}
      action={<NextButton onClick={onNext} disabled={me === null} />}
    >
      <fieldset className="grid gap-2">
        <legend className="sr-only">나</legend>
        {participants.map((name) => (
          <label key={name} className="flex items-center gap-2.5 rounded-lg border bg-sheet p-3 text-base has-checked:border-foreground">
            <input type="radio" name="me" checked={me === name} onChange={() => onMe(name)} />
            <span className="min-w-0 flex-1 break-all">{name}</span>
            <span aria-hidden className="text-sm text-muted-foreground tabular-nums">
              {formatCount(counts[name] ?? 0)}개
            </span>
          </label>
        ))}
      </fieldset>
    </StepFrame>
  );
}
