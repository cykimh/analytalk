"use client";

// 보낼 내용 확인: 고지(PRD 4장) → 요약(기간·메시지·읽을 범위·뺀 멤버·말투·가린 항목) → 미리보기 20줄 → 단톡방 동의 → [AI 연재 만들기].
// 안전 신호가 있으면 버튼 대신 도움 안내를, 직장·팀이면 버튼 대신 통계(AI는 M3)를 보인다. 단톡방이면 동의 체크 뒤에 만들 수 있다.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatCount } from "@/components/stats/format";
import { StatsDashboard } from "@/components/stats/StatsDashboard";
import { TONES } from "@/lib/llm/concepts";
import type { Payload } from "@/lib/payload/build";
import type { ChatMessage } from "@/lib/parse/parse";
import { sendSummary } from "./flow";
import { StepFrame } from "./StepFrame";

const MASK_LABEL: Record<string, string> = {
  phone: "전화번호",
  email: "이메일",
  account: "계좌",
  rrn: "주민번호",
  url: "링크(사이트 이름만 남김)",
};

const HELP: Record<"self_harm" | "violence", { title: string; lines: string[] }> = {
  self_harm: {
    title: "혼자 견디기 힘든 이야기가 보여요",
    lines: ["이 대화는 AI에게 보내지 않을게요.", "힘들 때는 109(자살예방상담전화, 24시간)에 전화하면 바로 이야기를 들어 줘요."],
  },
  violence: {
    title: "위험한 상황에 대한 이야기가 보여요",
    lines: [
      "이 대화는 AI에게 보내지 않을게요.",
      "지금 위험하다면 112, 가정·데이트 폭력 상담은 1366(여성긴급전화, 24시간)에서 도와줘요.",
    ],
  },
};

export function ReviewStep({
  payload,
  messages,
  excluded,
  me,
  safety,
  busy,
  onBack,
  onCreate,
}: {
  payload: Payload;
  /** 페이로드를 만든 메시지(이름 정리 뒤) */
  messages: ChatMessage[];
  /** 분석에서 뺀 멤버(카톡 이름·메시지 수). 화면에만 보이고 보내지 않는다 */
  excluded: { name: string; count: number }[];
  /** 통계 대시보드에서 강조할 표시 이름 */
  me: string;
  safety: "self_harm" | "violence" | null;
  busy: boolean;
  onBack: () => void;
  onCreate: () => void;
}) {
  const [told, setTold] = useState(false);
  const s = sendSummary(payload, messages, excluded);
  const masked = Object.entries(payload.maskCounts).filter(([, n]) => n > 0);
  const extra = [s.first > 0 && `첫 대화 ${formatCount(s.first)}개`, s.busy > 0 && `가장 활발했던 날 ${formatCount(s.busy)}개`]
    .filter(Boolean)
    .map((t) => ` + ${t}`)
    .join("");
  const group = payload.kind === "group";
  const work = payload.kind === "work";
  const note = work
    ? "직장·팀 리포트는 M3에서 열려요. 지금은 통계만 볼 수 있어요."
    : group && !told
      ? "방 사람들에게 말한 뒤에 만들 수 있어요."
      : "리포트는 몇 분 걸려요. 창을 닫아도 서버에서 계속 써요.";

  return (
    <StepFrame title="보낼 내용 확인" onBack={onBack} busy={busy}>
      <p className="rounded-xl bg-muted p-4 text-base">
        표시 이름과 대화 본문(전화·이메일·계좌·주민번호는 가리고 링크는 사이트 이름만)이 미국 Anthropic으로 가요. 표시 이름은 30일
        보관되고 공유 링크에 보여요. 뺀 멤버의 메시지는 보내지 않아요.
      </p>
      <dl className="grid gap-3 text-base tabular-nums">
        <div className="grid gap-0.5">
          <dt className="text-muted-foreground">기간</dt>
          <dd>{s.period}</dd>
        </div>
        <div className="grid gap-0.5">
          <dt className="text-muted-foreground">메시지</dt>
          <dd>{formatCount(s.total)}개</dd>
        </div>
        <div className="grid gap-0.5">
          <dt className="text-muted-foreground">읽을 범위</dt>
          <dd>
            {s.since} 이후 {formatCount(s.sent)}개 전부{extra}
          </dd>
        </div>
        <div className="grid gap-0.5">
          <dt className="text-muted-foreground">뺀 멤버</dt>
          <dd>{s.excluded.length === 0 ? "없음" : s.excluded.map((e) => `${e.name} ${formatCount(e.count)}개`).join(", ")}</dd>
        </div>
        {!work && (
          <div className="grid gap-0.5">
            <dt className="text-muted-foreground">말투</dt>
            <dd>{TONES[payload.tone].label}</dd>
          </div>
        )}
        <div className="grid gap-0.5">
          <dt className="text-muted-foreground">가린 항목</dt>
          <dd>
            {formatCount(s.masked)}개
            {masked.length > 0 && (
              <span className="text-muted-foreground">
                {" "}
                ({masked.map(([k, n]) => `${MASK_LABEL[k] ?? k} ${formatCount(n)}`).join(", ")})
              </span>
            )}
          </dd>
        </div>
      </dl>
      <details className="rounded-xl border bg-sheet p-3 text-base">
        <summary className="cursor-pointer font-medium">미리보기 20줄</summary>
        <pre className="mt-2 max-h-80 overflow-y-auto font-mono text-sm leading-relaxed break-all whitespace-pre-wrap">
          {s.preview.join("\n")}
        </pre>
      </details>

      {safety && (
        <div role="alert" className="grid gap-1 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-base">
          <p className="font-medium">{HELP[safety].title}</p>
          {HELP[safety].lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
      {safety || work ? (
        <div className="grid gap-3">
          {work && !safety && <p className="text-base text-muted-foreground">{note}</p>}
          <StatsDashboard stats={payload.stats} kind={payload.kind} me={payload.members.includes(me) ? me : payload.members[0]} look="plain" />
        </div>
      ) : (
        <div className="grid gap-3">
          {group && (
            <label className="flex items-center gap-2.5 py-2.5 text-base">
              <input type="checkbox" checked={told} onChange={(e) => setTold(e.target.checked)} />
              방 사람들에게 말했어요
            </label>
          )}
          <Button size="lg" disabled={busy || work || (group && !told)} onClick={onCreate}>
            {busy ? "보내는 중…" : "AI 연재 만들기"}
          </Button>
          <p className="text-base text-muted-foreground">{note}</p>
        </div>
      )}
    </StepFrame>
  );
}
