"use client";

// /new 흐름: 파일 → (Worker) 파싱 → 확인 → 이름 정리(+분석에서 빼기, 봇·알 수 없음은 목록에 없다) → 방 종류·말투
// → (Worker) 이름 적용·위험 신호 메시지 빼기·페이로드 → 보낼 내용 확인 → [연재 만들기](페이로드만 보낸다) → /c/[id](대화 홈).
// 업로더 본인을 고르지 않는다: 리포트는 방 밖의 제3자가 본 이야기다.
// 원본 파일·파싱 결과·뺀 멤버·봇·위험 신호 메시지는 이 컴포넌트와 Worker(브라우저 메모리)에만 있다.
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { savePayload, sweepPayloads } from "@/lib/client/idb";
import { rememberSeries } from "@/lib/client/recent";
import { createSeries, postJson } from "@/lib/client/submit";
import {
  buildInWorker,
  type BuildRequest,
  parseInWorker,
  renameInWorker,
  retryBuildInput,
} from "@/lib/client/worker";
import { TOKENS_PER_CHAR } from "@/lib/config";
import { DEFAULT_TONE, type PickableTone } from "@/lib/llm/concepts";
import type { Payload } from "@/lib/payload/build";
import type { ParseResult } from "@/lib/parse/parse";
import { ConfirmStep } from "./ConfirmStep";
import {
  conceptFor,
  defaultKind,
  excludedNames,
  includedRoots,
  initialNames,
  type Kind,
  mergedGroups,
  NAME_PROBLEM_TEXT,
  nameMapOf,
  nameProblem,
  type NameState,
  nameTargets,
} from "./flow";
import { KindStep } from "./KindStep";
import { NamesStep } from "./NamesStep";
import { ReviewStep } from "./ReviewStep";
import { StepFrame } from "./StepFrame";
import { UploadStep } from "./UploadStep";

type Step = "upload" | "confirm" | "names" | "kind" | "review";
/** 첫 페이로드를 만든 입력. 413이면 retryBuildInput(input, maxTokens)로 한 번 다시 만든다. safetyDropped: 위험 신호로 뺀 메시지 수 */
type Built = { payload: Payload; input: Extract<BuildRequest, { inputBudget: number }>; safetyDropped: number };

const NOT_KAKAO = "카카오톡 대화 내보내기 파일이 아닌 것 같아요. 내보낸 .txt·.csv·.zip 파일을 그대로 올려 주세요.";
const NO_MESSAGES = "읽을 메시지가 없어요. 대화 내용이 든 파일인지 확인해 주세요.";
const errorText = (error: unknown) => (error instanceof Error && error.message ? error.message : "브라우저에서 대화를 읽지 못했어요");

export function UploadFlow({ inApp, inputBudget }: { inApp: boolean; inputBudget: number }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("upload");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parse, setParse] = useState<ParseResult | null>(null);
  const [kind, setKind] = useState<Kind>("group");
  const [tone, setTone] = useState<PickableTone>(DEFAULT_TONE);
  const [kindChosen, setKindChosen] = useState(false);
  const [names, setNames] = useState<NameState>({ names: {}, sameAs: {}, excluded: [] });
  const [built, setBuilt] = useState<Built | null>(null);

  // 24시간 지난 재시도용 페이로드를 지운다(다른 대화를 올리러 왔을 때도)
  useEffect(() => {
    void sweepPayloads().catch(() => undefined);
  }, []);

  const targets = useMemo(() => (parse ? nameTargets(parse) : []), [parse]);
  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const m of parse?.messages ?? []) if (m.sender !== null && m.kind !== "system") out[m.sender] = (out[m.sender] ?? 0) + 1;
    return out;
  }, [parse]);
  const problem = parse ? nameProblem(names, targets) : null;
  const excluded = useMemo(
    () => excludedNames(names, targets).map((name) => ({ name, count: counts[name] ?? 0 })).filter((e) => e.count > 0),
    [names, targets, counts],
  );

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
      setKind(defaultKind(nameTargets(r).length));
      setKindChosen(false);
      setTone(DEFAULT_TONE);
      setNames(initialNames(nameTargets(r)));
      setBuilt(null);
      setStep("confirm");
    });

  /** 이름 단계 [다음]: Worker 없이 바로 검사해서 방 종류 단계로. 방 종류 기본값은 처음 들어올 때 남은 사람 수로 정한다 */
  const toKind = () => {
    if (problem) return;
    if (!kindChosen) setKind(defaultKind(includedRoots(names, targets).length));
    setError(null);
    setStep("kind");
  };

  /** 방 종류·말투 [다음]: 이름을 적용하고(뺀 멤버·봇·위험 신호 메시지 제외) 페이로드를 만든다 */
  const prepare = () =>
    run(async () => {
      if (!parse) return;
      const r = await renameInWorker({
        messages: parse.messages,
        map: nameMapOf(names, targets),
        merged: mergedGroups(names.sameAs),
        excluded: excludedNames(names, targets),
      });
      if (!r.ok) throw new Error("이름을 다시 확인해 주세요");
      const input = {
        messages: r.messages,
        concept: conceptFor(kind),
        kind,
        tone,
        tokensPerChar: TOKENS_PER_CHAR,
        inputBudget,
      };
      const payload = await buildInWorker(input);
      // 위험 신호 메시지를 빼고 나니 한 사람만 남았으면 리포트를 만들 수 없다
      if (payload.members.length < 2) throw new Error(NAME_PROBLEM_TEXT.too_few);
      setBuilt({ payload, input, safetyDropped: r.safetyDropped });
      setStep("review");
    });

  /**
   * [연재 만들기]: 202·200이면 받아 준 페이로드를 이 브라우저에 두고 대화 홈으로 간다(진행은 거기서 보인다).
   * 413이면 한 번만 줄여 다시 보낸다. 성공하면 화면이 바뀔 때까지 버튼을 막아 둔다
   */
  async function create() {
    if (!built) return;
    setBusy(true);
    setError(null);
    try {
      const r = await createSeries(built.payload, {
        post: postJson("/api/conversations"),
        rebuild: (maxTokens) => buildInWorker(retryBuildInput(built.input, maxTokens)),
        save: savePayload,
      });
      if (r.ok) {
        // 시작 화면의 '내 연재'에서 다시 찾을 수 있게 이 브라우저에 id만 남긴다
        rememberSeries({ id: r.id, concept: built.payload.concept, tone, createdAt: Date.now() });
        router.push(`/c/${r.id}`);
        return;
      }
      setError(r.message);
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  }

  const back = (to: Step) => () => {
    setError(null);
    setStep(to);
  };

  const errorBox = error && step !== "upload" && (
    <p role="alert" className="text-base text-destructive">
      {error}
    </p>
  );

  let body: ReactNode;
  if (step === "upload" || !parse) {
    body = <UploadStep inApp={inApp} busy={busy} error={error} onFiles={onFiles} />;
  } else if (step === "confirm") {
    body = <ConfirmStep parse={parse} onBack={back("upload")} onNext={back("names")} />;
  } else if (step === "names") {
    body = (
      <NamesStep targets={targets} state={names} problem={problem} busy={busy} onChange={setNames} onBack={back("confirm")} onNext={toKind} />
    );
  } else if (step === "kind") {
    body = (
      <KindStep
        kind={kind}
        tone={tone}
        busy={busy}
        onKind={(k) => {
          setKind(k);
          setKindChosen(true);
        }}
        onTone={setTone}
        onBack={back("names")}
        onNext={prepare}
      />
    );
  } else if (step === "review" && built) {
    body = (
      <ReviewStep
        payload={built.payload}
        excluded={excluded}
        safetyDropped={built.safetyDropped}
        busy={busy}
        onBack={back("kind")}
        onCreate={create}
      />
    );
  }

  return (
    <main className="mx-auto grid w-full max-w-2xl gap-4 px-4 py-8">
      {body}
      {errorBox}
    </main>
  );
}
