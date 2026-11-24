"use client";

// Cloudflare Turnstile 위젯(명시적 렌더). 토큰은 한 번만 쓸 수 있어 부모가 resetKey를 바꾸면 새로 받는다.
// 스크립트는 <Script nonce>로 넣는다. nonce는 layout이 proxy의 x-nonce를 읽어 내려 준다(CSP strict-dynamic)
import Script from "next/script";
import { useEffect, useRef, useState } from "react";
import { useNonce } from "@/components/NonceProvider";

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
  const nonce = useNonce();
  const box = useRef<HTMLDivElement>(null);
  const [api, setApi] = useState<TurnstileApi | null>(null);
  const widgetId = useRef<string | null>(null);
  // 콜백은 최신 것을 쓰되 위젯은 다시 그리지 않는다
  const handlers = useRef({ onToken, onError });
  useEffect(() => {
    handlers.current = { onToken, onError };
  });

  // 처음 받았을 때(onLoad)와 이미 받아 둔 뒤 다시 그릴 때(onReady) 모두 window.turnstile을 집는다
  const pickApi = () => (window.turnstile ? setApi(window.turnstile) : handlers.current.onError());

  useEffect(() => {
    if (!api || !box.current) return;
    const id = api.render(box.current, {
      sitekey: siteKey,
      action,
      language: "ko",
      size: box.current.clientWidth < 300 ? "compact" : "flexible",
      callback: (token: string) => handlers.current.onToken(token),
      "expired-callback": () => handlers.current.onToken(null),
      "error-callback": () => handlers.current.onError(),
    });
    if (!id) return;
    widgetId.current = id;
    return () => {
      api.remove(id);
      widgetId.current = null;
    };
  }, [api, siteKey, action]);

  useEffect(() => {
    if (resetKey > 0 && api && widgetId.current) api.reset(widgetId.current);
  }, [api, resetKey]);

  return (
    <>
      <Script src={SCRIPT_URL} nonce={nonce} onLoad={pickApi} onReady={pickApi} onError={() => handlers.current.onError()} />
      <div ref={box} className="min-h-16 w-full" />
    </>
  );
}
