"use client";

// 방 종류와 리포트 말투를 고른다. 직장·팀은 AI가 꺼져 있어 말투를 묻지 않는다.
// 말투는 모두 방 밖의 제3자가 바라본 컨셉이다(TONE_KEYS 순서, 기본 잔소리하는 친구)
import { type Tone, TONE_KEYS, TONES } from "@/lib/llm/concepts";
import { type Kind, KIND_LABEL } from "./flow";
import { NextButton, StepFrame } from "./StepFrame";

const KIND_NOTE: Record<Kind, string> = {
  pair: "둘이 나눈 대화. 연애·썸 컨셉으로 둘의 대화 균형을 봐요",
  group: "여럿이 있는 방. 방의 연대기와 멤버 캐릭터를 봐요",
  work: "M3 예정 · 지금은 통계만 볼 수 있어요",
};

const TONE_NOTE: Record<Tone, string> = {
  fact: "행동을 꼬집는 잔소리. “답장 늦는 거 다 보여”",
  warm: "같은 패턴을 서로를 이해하는 쪽으로, 다정하게",
  show: "과장된 비유와 별명, 자막 같은 한 줄",
  docu: "“이 무리는 해가 지면 비로소 활발해진다”",
  detective: "사건 개요·증거물·용의 패턴·결론, 진지한 척 수사 보고",
  record: "멤버마다 ‘행동 특성 및 종합 의견’을 적는 담임 코멘트",
};

export function KindStep({
  kind,
  tone,
  busy,
  onKind,
  onTone,
  onBack,
  onNext,
}: {
  kind: Kind;
  tone: Tone;
  busy: boolean;
  onKind: (kind: Kind) => void;
  onTone: (tone: Tone) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const radio = "flex items-start gap-2.5 rounded-lg border bg-sheet p-3 text-base has-checked:border-foreground";
  return (
    <StepFrame title="방 종류와 말투" onBack={onBack} busy={busy} action={<NextButton onClick={onNext} disabled={busy} />}>
      <fieldset className="grid gap-2" disabled={busy}>
        <legend className="mb-2 text-base font-bold">방 종류</legend>
        {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
          <label key={k} className={radio}>
            <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => onKind(k)} className="mt-1 shrink-0" />
            <span className="grid gap-0.5">
              <span className="font-medium">{KIND_LABEL[k]}</span>
              <span className="text-muted-foreground">{KIND_NOTE[k]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {kind !== "work" && (
        <fieldset className="grid gap-2" disabled={busy}>
          <legend className="mb-2 text-base font-bold">말투</legend>
          {TONE_KEYS.map((t) => (
            <label key={t} className={radio}>
              <input type="radio" name="tone" value={t} checked={tone === t} onChange={() => onTone(t)} className="mt-1 shrink-0" />
              <span className="grid gap-0.5">
                <span className="font-medium">{TONES[t].label}</span>
                <span className="text-muted-foreground">{TONE_NOTE[t]}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {busy && (
        <p role="status" className="text-base text-muted-foreground">
          보낼 내용을 만드는 중…
        </p>
      )}
    </StepFrame>
  );
}
