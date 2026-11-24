"use client";

// Cloudflare Turnstile 위젯(명시적 렌더). 토큰은 한 번만 쓸 수 있어 부모가 resetKey를 바꾸면 새로 받는다.
import { useEffect, useRef } from "react";

interface TurnstileApi {
  render: (container: HTMLElement, options: Record<string, unknown>) => string | undefined;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let scriptLoad: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptLoad ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile missing")));
    script.onerror = () => reject(new Error("turnstile load failed"));
    document.head.append(script);
  }).catch((error: unknown) => {
    scriptLoad = null;
    throw error;
  });
  return scriptLoad;
}

export function Turnstile({
  siteKey,
  action,
  resetKey,
  onToken,
  onError,
}: {
  siteKey: string;
  action: string;
  resetKey: number;
  onToken: (token: string | null) => void;
  onError: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<{ api: TurnstileApi; id: string } | null>(null);
  // 콜백은 최신 것을 쓰되 위젯은 다시 그리지 않는다
  const handlers = useRef({ onToken, onError });
  useEffect(() => {
    handlers.current = { onToken, onError };
  });

  useEffect(() => {
    let cancelled = false;
    loadTurnstile()
      .then((api) => {
        if (cancelled || !box.current) return;
        const id = api.render(box.current, {
          sitekey: siteKey,
          action,
          language: "ko",
          size: box.current.clientWidth < 300 ? "compact" : "flexible",
          callback: (token: string) => handlers.current.onToken(token),
          "expired-callback": () => handlers.current.onToken(null),
          "error-callback": () => handlers.current.onError(),
        });
        if (id) widget.current = { api, id };
      })
      .catch(() => handlers.current.onError());
    return () => {
      cancelled = true;
      if (widget.current) widget.current.api.remove(widget.current.id);
      widget.current = null;
    };
  }, [siteKey, action]);

  useEffect(() => {
    if (resetKey > 0 && widget.current) widget.current.api.reset(widget.current.id);
  }, [resetKey]);

  return <div ref={box} className="min-h-16 w-full" />;
}
