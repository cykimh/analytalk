"use client";

// 확인 화면: 기간·메시지 수·줄 인식률(98% 미만이면 경고)과 방 종류
import { formatCount, kstDate } from "@/components/stats/format";
import { RECOGNITION_WARN } from "@/lib/config";
import type { ParseResult } from "@/lib/parse/parse";
import { type Kind, KIND_LABEL, recognitionPercent } from "./flow";
import { NextButton, StepFrame } from "./StepFrame";

const KIND_NOTE: Record<Kind, string> = {
  pair: "둘이 나눈 대화. AI 연재는 연애·썸 컨셉으로 둘의 대화 균형을 봐요",
  group: "여럿이 있는 방. AI 연재는 방의 연대기와 멤버 캐릭터를 봐요",
  work: "M3 예정 · 지금은 통계만 볼 수 있어요",
};

export function ConfirmStep({
  parse,
  kind,
  onKind,
  onBack,
  onNext,
}: {
  parse: ParseResult;
  kind: Kind;
  onKind: (kind: Kind) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const count = parse.messages.filter((m) => m.sender !== null && m.kind !== "system").length;
  const pct = recognitionPercent(parse.recognizedRatio);
  return (
    <StepFrame title="읽은 내용 확인" onBack={onBack} action={<NextButton onClick={onNext} />}>
      <ul className="grid gap-1 rounded-xl bg-muted p-4 text-base tabular-nums">
        <li>
          기간 {parse.firstTs === null ? "-" : kstDate(parse.firstTs)} ~ {parse.lastTs === null ? "-" : kstDate(parse.lastTs)}
        </li>
        <li>메시지 {formatCount(count)}개</li>
        <li>참여자 {formatCount(parse.participants.length)}명</li>
        <li>인식률 {pct}%</li>
      </ul>
      {parse.recognizedRatio < RECOGNITION_WARN && (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-base text-destructive">
          인식하지 못한 줄이 있어요. 내보낸 파일을 고치지 않고 그대로 올렸는지 확인해 주세요. 이대로 계속하면 읽지 못한 줄은
          앞 메시지에 붙어요.
        </p>
      )}
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-base font-bold">방 종류</legend>
        {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
          <label key={k} className="flex items-start gap-2.5 rounded-lg border bg-sheet p-3 text-base has-checked:border-foreground">
            <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => onKind(k)} className="mt-1 shrink-0" />
            <span className="grid gap-0.5">
              <span className="font-medium">{KIND_LABEL[k]}</span>
              <span className="text-muted-foreground">{KIND_NOTE[k]}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </StepFrame>
  );
}
