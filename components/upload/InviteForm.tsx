"use client";

// 첫 방문: 초대 코드 + Turnstile → POST /api/invite → 30일 세션 쿠키. 통과하면 /new로 간다.
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { TURNSTILE_INVITE_ACTION } from "@/lib/config";
import { Turnstile } from "./Turnstile";

// 개발에서 키가 없으면 Cloudflare 공식 테스트 키(항상 통과). 프로덕션은 키가 없으면 위젯 없이 보내고 서버가 503·403으로 닫는다
const SITE_KEY =
  process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || (process.env.NODE_ENV === "production" ? undefined : "1x00000000000000000000AA");

const ERROR_TEXT: Record<string, string> = {
  invalid_code: "코드가 맞지 않아요. 받은 코드를 다시 확인해 주세요.",
  human_check_failed: "사람 확인을 마치지 못했어요. 다시 확인해 주세요.",
  not_ready: "아직 준비 중이에요. 잠시 후 다시 시도해 주세요.",
  bad_request: "코드를 확인해 주세요.",
};
const FALLBACK_ERROR = "잠시 후 다시 시도해 주세요.";

export function InviteForm() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = code.trim() !== "" && (!SITE_KEY || token !== null) && !busy;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code.trim(), turnstileToken: token ?? undefined }),
      });
      if (res.ok) {
        router.push("/new");
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(ERROR_TEXT[body.error ?? ""] ?? FALLBACK_ERROR);
    } catch {
      setError(FALLBACK_ERROR);
    }
    // 토큰은 한 번 쓰면 끝이라 새로 받는다
    setToken(null);
    setResetKey((k) => k + 1);
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="grid gap-3">
      <label className="grid gap-1.5 text-sm font-medium">
        초대 코드
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={64}
          className="h-10 rounded-lg border border-input bg-background px-3 font-mono text-base tracking-wider uppercase outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      </label>
      {SITE_KEY && (
        <Turnstile
          siteKey={SITE_KEY}
          action={TURNSTILE_INVITE_ACTION}
          resetKey={resetKey}
          onToken={setToken}
          onError={() => {
            setToken(null);
            setError(ERROR_TEXT.human_check_failed);
          }}
        />
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" size="lg" disabled={!ready}>
        들어가기
      </Button>
    </form>
  );
}
