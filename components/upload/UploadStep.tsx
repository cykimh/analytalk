"use client";

// 파일 고르기: .txt·.csv·.zip 여러 개(분할 내보내기), 데스크톱은 끌어다 놓기도 받는다
import { useState } from "react";
import { cn } from "@/lib/utils";
import { ExportGuide } from "./ExportGuide";
import { InAppBanner } from "./InAppBanner";
import { StepFrame } from "./StepFrame";

const ACCEPT = ".txt,.csv,.zip,text/plain,text/csv,application/zip";

export function UploadStep({
  inApp,
  busy,
  error,
  onFiles,
}: {
  inApp: boolean;
  busy: boolean;
  error: string | null;
  onFiles: (files: File[]) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const pick = (list: FileList | null) => {
    const files = list ? [...list] : [];
    if (files.length > 0 && !busy) onFiles(files);
  };

  return (
    <StepFrame
      title="대화 올리기"
      description="파일은 이 브라우저 안에서만 읽어요. 원본은 서버로 올라가지 않아요."
    >
      {inApp && <InAppBanner />}
      <ExportGuide />
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          pick(e.dataTransfer.files);
        }}
        className={cn(
          "grid cursor-pointer justify-items-center gap-1 rounded-xl border-2 border-dashed p-8 text-center text-base has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-foreground has-focus-visible:outline-solid",
          dragging ? "border-foreground bg-muted" : "border-border",
          busy && "pointer-events-none opacity-60",
        )}
      >
        <span className="font-bold">{busy ? "대화를 읽는 중…" : "파일 고르기"}</span>
        <span className="text-muted-foreground">.txt · .csv · .zip, 나뉜 파일은 한꺼번에 골라 주세요</span>
        <input
          type="file"
          multiple
          accept={ACCEPT}
          aria-label="대화 파일"
          className="sr-only"
          disabled={busy}
          onChange={(e) => {
            pick(e.target.files);
            e.target.value = "";
          }}
        />
      </label>
      {busy && (
        <p role="status" className="text-base text-muted-foreground">
          대화를 읽는 중이에요. 큰 파일은 몇 초 걸려요.
        </p>
      )}
      {error && (
        <p role="alert" className="text-base text-destructive">
          {error}
        </p>
      )}
    </StepFrame>
  );
}
