import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist } from "next/font/google";
import { APP_SCHEMA } from "@/lib/app";
import { cn } from "@/lib/utils";
import "./globals.css";

// 라틴 문자만 Geist, 한글은 시스템 폰트로 떨어진다.
const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = { title: APP_SCHEMA };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko" className={cn("font-sans", geist.variable)}>
      <body>{children}</body>
    </html>
  );
}
