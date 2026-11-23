# analytalk

공통 인프라(sideinfra) 위의 앱. 인프라 구성·규칙은 [sideinfra/CLAUDE.md](../sideinfra/CLAUDE.md) 가 원본이다.

- 스택: Next.js (App Router) + Supabase (`@supabase/ssr`) + Tailwind CSS v4 + shadcn/ui (base-nova), Vercel 배포 (함수 리전 icn1)
- UI 컴포넌트 추가: `pnpm dlx shadcn@latest add <컴포넌트>` → `components/ui/` 에 코드로 들어온다 (직접 수정 가능)
- Supabase 스키마: `analytalk` — 클라이언트는 `lib/supabase/{server,client}.ts` 가 이 스키마로 고정돼 있다
- **DB 변경은 이 저장소가 아니라 `sideinfra/supabase/migrations` 에 마이그레이션으로 추가한다.**
  모든 테이블은 RLS 를 켜고 정책을 둔다
- 로컬: `cp .env.example .env.local` 후 sideinfra 에서 `supabase status -o env` 값 입력 → `pnpm dev`
- 확인: `/api/health` 가 `{"db":"ok"}` 를 돌려줘야 한다

## analytalk 규칙

- 명령: `pnpm test`(vitest), `pnpm typecheck`, `pnpm test:e2e`(Playwright, dev 3100 / prod 3200), `pnpm check:fixtures`, `pnpm invite:add|revoke`(`--prod`는 `.env.production.local` 사용), `pnpm measure`, `pnpm eval`
- 저장 금지: 원본 대화 파일·전체 파싱 결과는 브라우저 밖으로 나가지 않는다. 페이로드의 `transcript`·`anchors`는 서버 메모리에서만 다루고 DB·Storage·로그(`console.*` 포함)에 남기지 않는다. 실제 이름은 저장·전송하지 않는다
- 실제 대화 파일은 커밋하지 않는다(공개 저장소). 테스트 파일은 줄 모양만 남긴 가짜 대화다
- 테스트 모드(E2E)는 `ANALYTALK_E2E === "1" && !process.env.VERCEL` 일 때만 켜진다. Vercel에서는 절대 켜지지 않는다
- 비밀값은 Vercel Sensitive 변수로 둔다. 에이전트는 `.env*`를 읽거나 쓰지 않는다(`.env.example`만 수정)
