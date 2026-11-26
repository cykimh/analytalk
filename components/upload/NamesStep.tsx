"use client";

// 이름 정리: 사람마다 리포트와 공유 링크에 보일 표시 이름을 정하고(기본은 카톡 이름), 분석에서 뺄 사람을 고른다.
// 한 사람의 여러 이름은 [같은 사람]으로 합친다. 쓸 수 없는 이름이면 [다음]을 막고 이유를 보여 준다.
import { checkDisplayName } from "@/lib/payload/names";
import { cn } from "@/lib/utils";
import { includedRoots, mergeInto, NAME_PROBLEM_TEXT, type NameProblem, type NameState, toggleExcluded, unmerge } from "./flow";
import { NextButton, StepFrame } from "./StepFrame";

export function NamesStep({
  targets,
  me,
  state,
  problem,
  busy,
  onChange,
  onBack,
  onNext,
}: {
  targets: string[];
  me: string;
  state: NameState;
  problem: NameProblem | null;
  busy: boolean;
  onChange: (state: NameState) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const roots = includedRoots(state, targets);
  const setName = (who: string, value: string) => onChange({ ...state, names: { ...state.names, [who]: value } });
  const row = (who: string) => {
    const root = state.sameAs[who];
    const value = state.names[who] ?? "";
    const out = state.excluded.includes(who);
    const invalid = root === undefined && !out && checkDisplayName(value) !== null;
    const id = `name-${targets.indexOf(who)}`;
    return (
      <li key={who} className={cn("grid gap-2 rounded-lg border bg-sheet p-3", out && "opacity-60")}>
        <div className="flex min-w-0 items-baseline justify-between gap-2 text-base">
          <label htmlFor={id} className="min-w-0 break-all font-medium">
            {who}
            {who === me && <span className="ml-1 text-sm text-muted-foreground">(나)</span>}
          </label>
          {root === undefined && (
            <label className="flex shrink-0 items-center gap-2 py-2.5 text-base">
              <input
                type="checkbox"
                aria-label={`${who} 분석에서 빼기`}
                checked={out}
                disabled={busy}
                onChange={() => onChange(toggleExcluded(state, who))}
              />{" "}
              분석에서 빼기
            </label>
          )}
        </div>
        {root === undefined ? (
          <div className="flex min-w-0 gap-2">
            <input
              id={id}
              aria-label={`${who}의 표시 이름`}
              value={value}
              maxLength={40}
              aria-invalid={invalid || undefined}
              disabled={busy || out}
              onChange={(e) => setName(who, e.target.value)}
              className={cn(
                "h-11 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground",
                invalid && "border-destructive",
              )}
            />
            {!out && roots.length > 1 && (
              <select
                aria-label={`${who}을(를) 합칠 사람`}
                value=""
                disabled={busy}
                onChange={(e) => e.target.value && onChange({ ...state, sameAs: mergeInto(state.sameAs, who, e.target.value), excluded: state.excluded.filter((x) => x !== who) })}
                className="h-11 w-32 shrink-0 rounded-lg border border-input bg-background px-2 text-base"
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
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-base">
            <span className="min-w-0 break-all text-muted-foreground">
              같은 사람: {root} · {state.names[root]}
            </span>
            <button
              type="button"
              className="min-h-11 px-2 text-base underline underline-offset-4 disabled:opacity-50"
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
      description="리포트와 공유 링크에 보일 이름이에요. 기본은 카톡 이름이고, 대화 본문은 바꾸지 않고 그대로 보내요."
      onBack={onBack}
      busy={busy}
      action={<NextButton onClick={onNext} disabled={problem !== null || busy} describedBy={problem ? "name-problem" : undefined} />}
    >
      <ul className="grid gap-2">{targets.map(row)}</ul>
      <p className="text-base tabular-nums">분석에 넣는 사람 {roots.length}명</p>
      {problem && (
        <p id="name-problem" role="alert" className="text-base text-destructive">
          {NAME_PROBLEM_TEXT[problem]}
        </p>
      )}
    </StepFrame>
  );
}
