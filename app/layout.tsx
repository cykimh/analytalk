import type { Metadata } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { connection } from "next/server";
import { NonceProvider } from "@/components/NonceProvider";
import { APP_SCHEMA } from "@/lib/app";
import { cn } from "@/lib/utils";
import { gaegu, pretendard, pretendardBold } from "./fonts";
import "./globals.css";

export const metadata: Metadata = { title: APP_SCHEMA };

// CSP nonce는 요청마다 바뀌어 미리 만든 HTML에 넣을 수 없다. 그래서 모든 페이지를 요청 때 렌더한다.
// cacheComponents(PPR)는 정적 셸에 nonce가 없어 켜지 않는다
export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="ko" className={cn("font-sans", pretendard.variable, pretendardBold.variable, gaegu.variable)}>
      <body>
        <NonceProvider nonce={nonce}>{children}</NonceProvider>
      </body>
    </html>
  );
}
