"use client";

// 이름 정리: 원래 이름마다 표시 이름을 정하고, 한 사람의 여러 이름은 [같은 사람]으로 합친다.
// applyDisplayNames가 실패할 이름이면 [다음]을 막고 이유를 보여 준다. 원래 이름은 이 화면(브라우저) 밖으로 나가지 않는다.
import { checkDisplayName, type NameError } from "@/lib/payload/names";
import { cn } from "@/lib/utils";
import { mergeInto, NAME_PROBLEM_TEXT, type NameState, unmerge } from "./flow";
import { NextButton, StepFrame } from "./StepFrame";

export function NamesStep({
  targets,
  senders,
  me,
  state,
  problem,
  busy,
  onChange,
  onBack,
  onNext,
}: {
  targets: string[];
  senders: Set<string>;
  me: string;
  state: NameState;
  problem: NameError | null;
  busy: boolean;
  onChange: (state: NameState) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const roots = targets.filter((t) => state.sameAs[t] === undefined);
  const setName = (who: string, value: string) => onChange({ ...state, names: { ...state.names, [who]: value } });
  const row = (who: string) => {
    const root = state.sameAs[who];
    const value = state.names[who] ?? "";
    const invalid = root === undefined && checkDisplayName(value) !== null;
    const id = `name-${targets.indexOf(who)}`;
    return (
      <li key={who} className="grid gap-2 rounded-lg border p-3">
        <div className="flex min-w-0 items-baseline justify-between gap-2 text-sm">
          <label htmlFor={id} className="min-w-0 break-all font-medium">
            {who}
            {who === me && <span className="ml-1 text-xs text-muted-foreground">(나)</span>}
          </label>
          {!senders.has(who) && <span className="shrink-0 text-xs text-muted-foreground">알림에만 나옴</span>}
        </div>
        {root === undefined ? (
          <div className="flex min-w-0 gap-2">
            <input
              id={id}
              aria-label={`${who}의 표시 이름`}
              value={value}
              maxLength={40}
              aria-invalid={invalid || undefined}
              disabled={busy}
              onChange={(e) => setName(who, e.target.value)}
              className={cn(
                "h-9 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-base outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                invalid && "border-destructive",
              )}
            />
            {roots.length > 1 && (
              <select
                aria-label={`${who}을(를) 합칠 사람`}
                value=""
                disabled={busy}
                onChange={(e) => e.target.value && onChange({ ...state, sameAs: mergeInto(state.sameAs, who, e.target.value) })}
                className="h-9 w-28 shrink-0 rounded-lg border border-input bg-background px-2 text-sm"
              >
                <option value="">같은 사람…</option>
                {roots
                  .filter((r) => r !== who)
                  .map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
              </select>
            )}
          </div>
        ) : (
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-sm">
            <span className="min-w-0 break-all text-muted-foreground">
              같은 사람: {root} · {state.names[root]}
            </span>
            <button
              type="button"
              className="text-xs underline disabled:opacity-50"
              disabled={busy}
              onClick={() => onChange({ ...state, sameAs: unmerge(state.sameAs, who) })}
            >
              풀기
            </button>
          </div>
        )}
      </li>
    );
  };

  return (
    <StepFrame
      title="이름 정리"
      description="AI와 서버는 여기서 정한 표시 이름만 봐요. 실제 이름 대신 별명을 써 주세요. 본문 속 이름도 함께 바꿔요."
      onBack={onBack}
      busy={busy}
      action={<NextButton onClick={onNext} disabled={problem !== null || busy} describedBy={problem ? "name-problem" : undefined} />}
    >
      <ul className="grid gap-2">{targets.map(row)}</ul>
      {problem && (
        <p id="name-problem" role="alert" className="text-sm text-destructive">
          {NAME_PROBLEM_TEXT[problem]}
        </p>
      )}
      {busy && (
        <p role="status" className="text-sm text-muted-foreground">
          본문 속 이름을 바꾸는 중…
        </p>
      )}
    </StepFrame>
  );
}
