"use client";

// 이름을 바꾼 뒤에도 본문에 남은 원래 이름 조각(findNameLeftovers). 조각마다 표시 이름으로 바꾸거나 그대로 둔다.
// 조각에는 실제 이름이 들어 있어 이 화면(브라우저)에서만 보여 준다.
import type { NameLeftover } from "@/lib/payload/names";
import type { ChatMessage } from "@/lib/parse/parse";
import { NextButton, StepFrame } from "./StepFrame";

const KEEP = "";
const SNIPPET_RADIUS = 18;

/** 조각이 처음 나온 메시지의 앞뒤 몇 글자 */
function snippet(messages: ChatMessage[], l: NameLeftover): string {
  const id = l.ids[0];
  const m = messages[id]?.id === id ? messages[id] : messages.find((x) => x.id === id);
  if (!m) return "";
  const at = m.text.toLowerCase().indexOf(l.piece.toLowerCase());
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(m.text.length, at + l.piece.length + SNIPPET_RADIUS);
  return `${start > 0 ? "…" : ""}${m.text.slice(start, end).replace(/\s+/g, " ")}${end < m.text.length ? "…" : ""}`;
}

export function LeftoversStep({
  leftovers,
  messages,
  displayNames,
  fixes,
  busy,
  onFixes,
  onBack,
  onNext,
}: {
  leftovers: NameLeftover[];
  messages: ChatMessage[];
  displayNames: string[];
  fixes: Record<string, string>;
  busy: boolean;
  onFixes: (fixes: Record<string, string>) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <StepFrame
      title="본문에 남은 이름"
      description="이름을 바꾼 뒤에도 원래 이름 조각이 남은 곳이 있어요. 그대로 두면 AI에게 보내는 대화에 실려요."
      onBack={onBack}
      action={<NextButton onClick={onNext} disabled={busy} />}
    >
      <ul className="grid gap-2">
        {leftovers.map((l) => (
          <li key={l.piece} className="grid gap-2 rounded-lg border p-3 text-sm">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium break-all">{l.piece}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{l.count}번</span>
            </div>
            <p className="break-all text-muted-foreground">{snippet(messages, l)}</p>
            <select
              aria-label={`${l.piece} 바꾸기`}
              value={fixes[l.piece] ?? KEEP}
              onChange={(e) => {
                const { [l.piece]: _, ...rest } = fixes;
                onFixes(e.target.value === KEEP ? rest : { ...rest, [l.piece]: e.target.value });
              }}
              className="h-9 rounded-lg border border-input bg-background px-2"
            >
              <option value={KEEP}>그대로 두기</option>
              {displayNames.map((name) => (
                <option key={name} value={name}>
                  {name}(으)로 바꾸기
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>
      {busy && (
        <p role="status" className="text-sm text-muted-foreground">
          바꾸는 중…
        </p>
      )}
    </StepFrame>
  );
}
