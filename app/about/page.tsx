import type { Metadata } from "next";
import Link from "next/link";
import { AI_NOTICE } from "@/components/episode/model";
import { MAX_QUOTES_PER_EPISODE, RETENTION_DAYS } from "@/lib/config";

export const metadata: Metadata = { title: "안내 · analytalk" };

// PRD 12 최소 고지 한 장: 무엇이 어디로 가는지, 보관 기간, 삭제 방법, 연락 방법. 쿠키 없이 누구나 본다
export default function AboutPage() {
  return (
    <main className="mx-auto grid w-full max-w-2xl min-w-0 gap-8 px-4 py-10 text-sm leading-relaxed">
      <header className="grid gap-2">
        <h1 className="font-hand text-[2.25rem] leading-tight font-bold">analytalk 안내</h1>
        <p className="text-muted-foreground">
          카톡 대화 내보내기 파일을 브라우저 안에서 읽어 통계를 보여 주고, 원하면 AI가 4편짜리 연재로 써 주는 지인용 서비스예요.
        </p>
      </header>

      <section aria-labelledby="where-title" className="grid gap-2">
        <h2 id="where-title" className="font-hand text-[1.375rem] leading-tight font-bold">
          무엇이 어디로 가나요
        </h2>
        <ul className="grid list-disc gap-1.5 pl-5">
          <li>원본 대화 파일은 이 기기의 브라우저 안에서만 읽어요. 서버로 올리지 않고, 탭을 닫으면 사라져요.</li>
          <li>
            AI 연재를 만들면 이름을 바꾸고 일부를 가린 최근 대화와 통계가 서버를 거쳐 미국 Anthropic으로 가요. 서버는 이 대화를
            메모리에서만 다루고 저장하지 않아요. Anthropic은 30일 보관하고(정책 위반으로 표시되면 최대 2년), 학습에는 쓰지 않아요.
          </li>
          <li>다시 쓰기용 페이로드는 이 브라우저에만 두고, 4편이 모두 끝나거나 24시간이 지나면 지워요.</li>
          <li>
            서버에는 연재 4편(본문, 근거로 고른 실제 메시지 편당 {MAX_QUOTES_PER_EPISODE}개까지, 읽기 메모)과 대화 요약(표시 이름,
            기간, 메시지 수, 통계)만 남겨요. 지인끼리 링크로 돌려 보기 위해서예요.
          </li>
        </ul>
      </section>

      <section aria-labelledby="keep-title" className="grid gap-2">
        <h2 id="keep-title" className="font-hand text-[1.375rem] leading-tight font-bold">
          보관과 삭제
        </h2>
        <ul className="grid list-disc gap-1.5 pl-5">
          <li>연재와 대화 요약은 {RETENTION_DAYS}일 뒤 자동으로 지워요.</li>
          <li>
            그 전에 지우려면 대화 화면 아래의 [지금 삭제]를 누르세요. 4편, 통계, 피드백이 함께 지워지고 되돌릴 수 없어요. 공유 링크도
            함께 끊겨요.
          </li>
        </ul>
      </section>

      <section aria-labelledby="contact-title" className="grid gap-2">
        <h2 id="contact-title" className="font-hand text-[1.375rem] leading-tight font-bold">
          연락
        </h2>
        <p>궁금한 점이나 삭제 요청은 초대 코드를 준 운영자에게 카톡으로 알려 주세요.</p>
      </section>

      <section aria-labelledby="note-title" className="grid gap-2">
        <h2 id="note-title" className="font-hand text-[1.375rem] leading-tight font-bold">
          알아 두세요
        </h2>
        <ul className="grid list-disc gap-1.5 pl-5">
          <li>analytalk는 카카오와 무관한 개인 프로젝트예요.</li>
          <li>
            연재와 해석은 AI가 쓴 글이에요({AI_NOTICE}). 숫자는 코드가 세고, 상대의 속마음은 단정하지 않아요.
          </li>
        </ul>
      </section>

      <Link href="/" className="justify-self-start text-sm font-medium underline underline-offset-4">
        처음 화면으로
      </Link>
    </main>
  );
}
