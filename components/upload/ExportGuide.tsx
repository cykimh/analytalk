"use client";

// OS별 3컷 내보내기 가이드. 모바일은 '텍스트만 보내기'를 권하고, PC는 그 기기에 남은 범위만 나온다고 알린다.
import { useState } from "react";
import { cn } from "@/lib/utils";

const GUIDES = {
  android: {
    label: "Android",
    steps: ["대화방 오른쪽 위 메뉴(≡) → 설정(톱니바퀴)", "'대화 내용 내보내기'", "'텍스트만 보내기' → 내 파일에 저장한 뒤 여기서 고르기"],
    note: "사진·동영상까지 보내면 파일이 커져요. '텍스트만 보내기'를 권해요.",
  },
  ios: {
    label: "iPhone",
    steps: ["대화방 오른쪽 위 메뉴(≡) → 설정(톱니바퀴)", "'대화 내용 내보내기'", "'텍스트만 보내기' → '파일에 저장'한 뒤 여기서 고르기"],
    note: "zip 파일 그대로 올려도 돼요. 안의 txt만 읽어요.",
  },
  windows: {
    label: "Windows",
    steps: ["대화방 오른쪽 위 메뉴(≡)", "'대화 내용' → '대화 내보내기'", "저장한 .txt 파일을 여기로 끌어다 놓기"],
    note: "PC는 이 컴퓨터에 동기화된 대화만 나와요. 오래된 대화는 빠질 수 있어요.",
  },
  mac: {
    label: "Mac",
    steps: ["대화방 오른쪽 위 메뉴(≡)", "'대화 내보내기'", "저장한 .csv 파일을 여기로 끌어다 놓기"],
    note: "PC는 이 컴퓨터에 동기화된 대화만 나와요. 오래된 대화는 빠질 수 있어요.",
  },
} as const;

type Os = keyof typeof GUIDES;

export function ExportGuide() {
  const [os, setOs] = useState<Os>("android");
  const guide = GUIDES[os];
  return (
    <section aria-labelledby="guide-title" className="grid gap-3">
      <h3 id="guide-title" className="text-sm font-medium">
        내보내는 법
      </h3>
      <div role="group" aria-label="기기" className="flex flex-wrap gap-1.5">
        {(Object.keys(GUIDES) as Os[]).map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={os === key}
            onClick={() => setOs(key)}
            className={cn(
              "rounded-full border px-3 py-1 text-sm",
              os === key ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground",
            )}
          >
            {GUIDES[key].label}
          </button>
        ))}
      </div>
      <ol className="grid gap-2 sm:grid-cols-3">
        {guide.steps.map((step, i) => (
          <li key={step} className="grid gap-1 rounded-lg bg-muted p-3 text-sm">
            <span className="text-xs font-semibold text-muted-foreground">{i + 1}</span>
            {step}
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted-foreground">{guide.note}</p>
    </section>
  );
}
