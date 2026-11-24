"use client";

// app/layout.tsx가 proxy의 x-nonce를 읽어 내려 준다. 클라이언트에서 넣는 외부 스크립트(Turnstile)의 <Script nonce>에 쓴다
import { createContext, type ReactNode, useContext } from "react";

const NonceContext = createContext<string | undefined>(undefined);

export function NonceProvider({ nonce, children }: { nonce: string | undefined; children: ReactNode }) {
  return <NonceContext value={nonce}>{children}</NonceContext>;
}

export const useNonce = () => useContext(NonceContext);
