import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist } from "next/font/google";
import { headers } from "next/headers";
import { connection } from "next/server";
import { NonceProvider } from "@/components/NonceProvider";
import { APP_SCHEMA } from "@/lib/app";
import { cn } from "@/lib/utils";
import "./globals.css";

// 라틴 문자만 Geist, 한글은 시스템 폰트로 떨어진다.
const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = { title: APP_SCHEMA };

// CSP nonce는 요청마다 바뀌어 미리 만든 HTML에 넣을 수 없다. 그래서 모든 페이지를 요청 때 렌더한다.
// cacheComponents(PPR)는 정적 셸에 nonce가 없어 켜지 않는다
export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="ko" className={cn("font-sans", geist.variable)}>
      <body>
        <NonceProvider nonce={nonce}>{children}</NonceProvider>
      </body>
    </html>
  );
}
