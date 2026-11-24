import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { UploadFlow } from "@/components/upload/UploadFlow";
import { isKakaoInApp } from "@/lib/client/inapp";
import { hasInvite } from "@/lib/server/viewer";

export const metadata: Metadata = { title: "대화 올리기 · analytalk" };

// 초대 코드 세션이 있어야 들어온다. 파일은 이 화면의 Web Worker가 읽고 서버로 올리지 않는다
export default async function NewPage() {
  if (!(await hasInvite())) redirect("/");
  const ua = (await headers()).get("user-agent") ?? "";
  return <UploadFlow inApp={isKakaoInApp(ua)} />;
}
