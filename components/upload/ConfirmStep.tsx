"use client";

// 확인 화면: 기간·메시지 수·참여자 수(봇·알 수 없음 제외)·줄 인식률(98% 미만이면 경고)
import { formatCount, kstDate } from "@/components/stats/format";
import { RECOGNITION_WARN } from "@/lib/config";
import type { ParseResult } from "@/lib/parse/parse";
import { nameTargets, recognitionPercent } from "./flow";
import { NextButton, StepFrame } from "./StepFrame";

export function ConfirmStep({
  parse,
  onBack,
  onNext,
}: {
  parse: ParseResult;
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
        <li>참여자 {formatCount(nameTargets(parse).length)}명</li>
        <li>인식률 {pct}%</li>
      </ul>
      {parse.recognizedRatio < RECOGNITION_WARN && (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-base text-destructive">
          인식하지 못한 줄이 있어요. 내보낸 파일을 고치지 않고 그대로 올렸는지 확인해 주세요. 이대로 계속하면 읽지 못한 줄은
          앞 메시지에 붙어요.
        </p>
      )}
    </StepFrame>
  );
}
