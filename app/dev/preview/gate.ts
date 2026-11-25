// dev 미리보기는 개발 서버(next dev)에서만 연다. 프로덕션 빌드(Vercel 포함)에서는 404다
import { notFound } from "next/navigation";

export function devOnly(): void {
  if (process.env.NODE_ENV === "production") notFound();
}
