"use client";

// OS별 3컷 내보내기 가이드. 모바일은 '텍스트만 보내기'를 권하고, PC는 그 기기에 남은 범위만 나온다고 알린다.
// v2.8: 파일로 바로 저장이 안 될 때(또는 PC에 오래된 대화가 없을 때) 메일로 나에게 보내 .txt 첨부를 받는 길을 OS마다 덧붙인다.
// 메일로 받은 .txt를 그대로 올리면 된다(zip으로 묶지 않아도 된다). 서버로 메일을 받는 기능은 없다: 메일은 사용자 메일함 안에서만 오간다
import { useState } from "react";
import { cn } from "@/lib/utils";

const GUIDES = {
  android: {
    label: "Android",
    steps: ["대화방 오른쪽 위 메뉴(≡) → 설정(톱니바퀴)", "'대화 내용 내보내기'", "'텍스트만 보내기' → 내 파일에 저장한 뒤 여기서 고르기"],
    note: "사진·동영상까지 보내면 파일이 커져요. '텍스트만 보내기'를 권해요.",
    mail: {
      title: "파일로 바로 저장이 안 되면: 메일로 나에게 보내기",
      steps: ["'텍스트만 보내기' → 메일 앱(Gmail 등) 고르기", "받는 사람에 내 메일 주소를 넣어 나에게 보내기", "받은 메일의 .txt 첨부를 눌러 다운로드한 뒤 여기서 고르기"],
    },
  },
  ios: {
    label: "iPhone",
    steps: ["대화방 오른쪽 위 메뉴(≡) → 설정(톱니바퀴)", "'대화 내용 내보내기'", "'텍스트만 보내기' → '파일에 저장'한 뒤 여기서 고르기"],
    note: "zip 파일 그대로 올려도 돼요. 안의 txt만 읽어요.",
    mail: {
      title: "파일로 바로 저장이 안 되면: 메일로 나에게 보내기",
      steps: ["'텍스트만 보내기' → 메일 앱 고르기", "받는 사람에 내 메일 주소를 넣어 나에게 보내기", "받은 메일의 .txt 첨부를 길게 눌러 '파일에 저장'한 뒤 여기서 고르기"],
    },
  },
  windows: {
    label: "Windows",
    steps: ["대화방 오른쪽 위 메뉴(≡)", "'대화 내용' → '대화 내보내기'", "저장한 .txt 파일을 여기로 끌어다 놓기"],
    note: "PC는 이 컴퓨터에 동기화된 대화만 나와요. 오래된 대화는 빠질 수 있어요.",
    mail: {
      title: "오래된 대화까지 쓰려면: 휴대폰에서 메일로 나에게 보내기",
      steps: [
        "휴대폰 카톡: 채팅방 설정 → '대화 내용 내보내기' → '텍스트만 보내기'",
        "메일 앱으로 내 메일 주소에 보내기",
        "이 PC에서 메일을 열어 .txt 첨부를 받은 뒤 여기로 끌어다 놓기",
      ],
    },
  },
  mac: {
    label: "Mac",
    steps: ["대화방 오른쪽 위 메뉴(≡)", "'대화 내보내기'", "저장한 .csv 파일을 여기로 끌어다 놓기"],
    note: "PC는 이 컴퓨터에 동기화된 대화만 나와요. 오래된 대화는 빠질 수 있어요.",
    mail: {
      title: "오래된 대화까지 쓰려면: 휴대폰에서 메일로 나에게 보내기",
      steps: [
        "휴대폰 카톡: 채팅방 설정 → '대화 내용 내보내기' → '텍스트만 보내기'",
        "메일 앱으로 내 메일 주소에 보내기",
        "이 PC에서 메일을 열어 .txt 첨부를 받은 뒤 여기로 끌어다 놓기",
      ],
    },
  },
} as const;

type Os = keyof typeof GUIDES;

/** 메일로 받은 파일 안내(모든 OS 같다) */
const MAIL_NOTE = "메일로 받은 .txt 파일을 그대로 올리면 돼요. zip으로 묶지 않아도 돼요(.txt·.csv·.zip 모두 받아요).";

export function ExportGuide() {
  const [os, setOs] = useState<Os>("android");
  const guide = GUIDES[os];
  return (
    <section aria-labelledby="guide-title" className="grid gap-3">
      <h3 id="guide-title" className="text-base font-bold">
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
              "min-h-11 rounded-full border px-4 text-base",
              os === key ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground",
            )}
          >
            {GUIDES[key].label}
          </button>
        ))}
      </div>
      <ol className="grid gap-2 sm:grid-cols-3">
        {guide.steps.map((step, i) => (
          <li key={step} className="grid gap-1 rounded-lg bg-muted p-3 text-base">
            <span className="text-sm font-bold text-muted-foreground">{i + 1}</span>
            {step}
          </li>
        ))}
      </ol>
      <p className="text-base text-muted-foreground">{guide.note}</p>
      <section aria-labelledby="guide-mail-title" className="grid gap-2 rounded-lg border border-dashed border-border p-3">
        <h4 id="guide-mail-title" className="text-base font-bold">
          {guide.mail.title}
        </h4>
        <ol className="grid list-decimal gap-1.5 pl-5 text-base">
          {guide.mail.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p className="text-base text-muted-foreground">{MAIL_NOTE}</p>
      </section>
    </section>
  );
}
