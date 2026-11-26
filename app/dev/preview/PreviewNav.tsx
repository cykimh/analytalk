// dev 미리보기 화면 사이를 오가는 작은 줄(미리보기에만 있다)
import Link from "next/link";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/dev/preview", key: "sheet", label: "조각 모음" },
  { href: "/dev/preview/home", key: "home", label: "대화 홈" },
  { href: "/dev/preview/report", key: "report", label: "리포트 읽기" },
  { href: "/dev/preview/share", key: "share", label: "공유 화면" },
];

export function PreviewNav({ current }: { current: string }) {
  return (
    <nav aria-label="미리보기" className="mx-auto flex max-w-[430px] flex-wrap gap-x-3 gap-y-1 px-4 pt-4 text-sm">
      <span className="text-ink-soft">dev 미리보기</span>
      {LINKS.map((l) => (
        <Link
          key={l.key}
          href={l.href}
          aria-current={l.key === current ? "page" : undefined}
          className={cn("underline-offset-4 hover:underline", l.key === current && "font-bold underline")}
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
