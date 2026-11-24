"use client";

// /new 흐름: 파일 → (Worker) 파싱 → 확인·방 종류 → 나는 누구? → 이름 정리 → 남은 이름 → (Worker) 페이로드 → 통계 → 보낼 내용 확인.
// 원본 파일·파싱 결과·실제 이름은 이 컴포넌트와 Worker(브라우저 메모리)에만 있다.
import { type ReactNode, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { StatsDashboard } from "@/components/stats/StatsDashboard";
import { buildInWorker, type BuildRequest, parseInWorker, type RenameResult, renameInWorker } from "@/lib/client/worker";
import { INPUT_TOKEN_BUDGET, TOKENS_PER_CHAR } from "@/lib/config";
import type { Payload } from "@/lib/payload/build";
import type { ParseResult } from "@/lib/parse/parse";
import { ConfirmStep } from "./ConfirmStep";
import {
  conceptFor,
  defaultKind,
  initialNames,
  type Kind,
  leftoverOwner,
  mergedGroups,
  nameMapOf,
  nameProblem,
  type NameState,
  nameTargets,
} from "./flow";
import { LeftoversStep } from "./LeftoversStep";
import { MeStep } from "./MeStep";
import { NamesStep } from "./NamesStep";
import { ReviewStep } from "./ReviewStep";
import { StepFrame } from "./StepFrame";
import { UploadStep } from "./UploadStep";

type Step = "upload" | "confirm" | "me" | "names" | "leftovers" | "stats" | "review";
type Renamed = Extract<RenameResult, { ok: true }>;
/** 첫 페이로드를 만든 입력. 413이면 Task 13이 retryBuildInput(input, maxTokens)로 한 번 다시 만든다 */
type Built = { payload: Payload; input: Extract<BuildRequest, { inputBudget: number }> };

const NOT_KAKAO = "카카오톡 대화 내보내기 파일이 아닌 것 같아요. 내보낸 .txt·.csv·.zip 파일을 그대로 올려 주세요.";
const NO_MESSAGES = "읽을 메시지가 없어요. 대화 내용이 든 파일인지 확인해 주세요.";
const errorText = (error: unknown) => (error instanceof Error && error.message ? error.message : "브라우저에서 대화를 읽지 못했어요");

export function UploadFlow({ inApp }: { inApp: boolean }) {
  const [step, setStep] = useState<Step>("upload");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parse, setParse] = useState<ParseResult | null>(null);
  const [kind, setKind] = useState<Kind>("group");
  const [me, setMe] = useState<string | null>(null);
  const [names, setNames] = useState<NameState>({ names: {}, sameAs: {} });
  const [renamed, setRenamed] = useState<Renamed | null>(null);
  const [fixes, setFixes] = useState<Record<string, string>>({});
  const [built, setBuilt] = useState<Built | null>(null);

  const targets = useMemo(() => (parse ? nameTargets(parse) : []), [parse]);
  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const m of parse?.messages ?? []) if (m.sender !== null && m.kind !== "system") out[m.sender] = (out[m.sender] ?? 0) + 1;
    return out;
  }, [parse]);
  const problem = parse ? nameProblem(names, targets) : null;
  const map = nameMapOf(names, targets);

  /** 비동기 단계 하나. 실패하면 문구를 보여 주고 그 자리에 남는다 */
  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const onFiles = (files: File[]) =>
    run(async () => {
      const r = await parseInWorker(files);
      if (r.formatId === null) throw new Error(NOT_KAKAO);
      if (!r.messages.some((m) => m.sender !== null && m.kind !== "system")) throw new Error(NO_MESSAGES);
      setParse(r);
      setKind(defaultKind(r.participants.length));
      setMe(null);
      setNames(initialNames(nameTargets(r)));
      setRenamed(null);
      setFixes({});
      setBuilt(null);
      setStep("confirm");
    });

  /**
   * 이름을 바꾸고(남은 조각은 withFixes대로) 페이로드를 만든다.
   * 이름 정리 화면에서 왔고 남은 조각이 있으면 먼저 '본문에 남은 이름' 화면을 보여 준다
   */
  const applyNames = (withFixes: Record<string, string>, reviewLeftovers: boolean) =>
    run(async () => {
      if (!parse || !me) return;
      const r = await renameInWorker({
        messages: parse.messages,
        map,
        systemNames: parse.systemNames,
        merged: mergedGroups(names.sameAs),
        fixes: withFixes,
      });
      if (!r.ok) throw new Error("이름을 다시 확인해 주세요");
      setRenamed(r);
      if (reviewLeftovers && r.leftovers.length > 0) {
        // 조각의 주인이 분명하면 그 표시 이름으로 바꾸기를 미리 골라 둔다
        const suggested: Record<string, string> = {};
        for (const l of r.leftovers) {
          const owner = leftoverOwner(l.piece, map);
          if (owner) suggested[l.piece] = owner;
        }
        setFixes(suggested);
        setStep("leftovers");
        return;
      }
      const input = {
        messages: r.messages,
        me: map[me],
        concept: conceptFor(kind),
        kind,
        tokensPerChar: TOKENS_PER_CHAR,
        inputBudget: INPUT_TOKEN_BUDGET,
      };
      setBuilt({ payload: await buildInWorker(input), input });
      setStep("stats");
    });

  const back = (to: Step) => () => {
    setError(null);
    setStep(to);
  };

  const errorBox = error && step !== "upload" && (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  );

  let body: ReactNode;
  if (step === "upload" || !parse) {
    body = <UploadStep inApp={inApp} busy={busy} error={error} onFiles={onFiles} />;
  } else if (step === "confirm") {
    body = <ConfirmStep parse={parse} kind={kind} onKind={setKind} onBack={back("upload")} onNext={back("me")} />;
  } else if (step === "me") {
    body = (
      <MeStep participants={parse.participants} counts={counts} me={me} onMe={setMe} onBack={back("confirm")} onNext={back("names")} />
    );
  } else if (step === "names" && me) {
    body = (
      <NamesStep
        targets={targets}
        senders={new Set(parse.participants)}
        me={me}
        state={names}
        problem={problem}
        busy={busy}
        onChange={setNames}
        onBack={back("me")}
        onNext={() => applyNames({}, true)}
      />
    );
  } else if (step === "leftovers" && renamed) {
    body = (
      <LeftoversStep
        leftovers={renamed.leftovers}
        messages={renamed.messages}
        displayNames={[...new Set(Object.values(map))]}
        fixes={fixes}
        busy={busy}
        onFixes={setFixes}
        onBack={back("names")}
        onNext={() => applyNames(fixes, false)}
      />
    );
  } else if (step === "stats" && built) {
    body = (
      <StepFrame
        title="대화 통계"
        description="숫자는 모두 이 브라우저에서 셌어요."
        onBack={back("names")}
        action={
          <Button size="lg" onClick={back("review")}>
            보낼 내용 확인
          </Button>
        }
      >
        <StatsDashboard stats={built.payload.stats} kind={built.payload.kind} me={built.payload.me} />
      </StepFrame>
    );
  } else if (step === "review" && built && renamed) {
    body = <ReviewStep payload={built.payload} messages={built.input.messages} safety={renamed.safety} onBack={back("stats")} />;
  }

  return (
    <main className="mx-auto grid w-full max-w-2xl gap-4 px-4 py-8">
      {body}
      {errorBox}
    </main>
  );
}
