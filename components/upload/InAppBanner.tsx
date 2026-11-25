"use client";

// 카카오톡 인앱 브라우저 안내. 파일 선택이 막히거나 쿠키가 외부 브라우저와 따로라서 외부로 열게 한다.
import { useEffect, useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { openExternalUrl } from "@/lib/client/inapp";

export function InAppBanner() {
  // 주소는 브라우저에서만 안다(서버 렌더에는 href가 없다)
  const [href, setHref] = useState<string>();
  useEffect(() => setHref(openExternalUrl(window.location.href)), []);

  return (
    <div role="note" className="grid gap-2 rounded-xl border border-ink/15 bg-sticker-butter p-4 text-base text-ink">
      <p className="font-bold">카카오톡 안에서 열었어요</p>
      <p>카카오톡 안의 브라우저에서는 파일을 고르지 못할 수 있어요. 기본 브라우저로 열어 주세요.</p>
      <a href={href} className={buttonVariants({ className: "justify-self-start" })}>
        외부 브라우저로 열기
      </a>
    </div>
  );
}
