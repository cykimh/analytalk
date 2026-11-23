# analytalk

공통 인프라(sideinfra) 위의 앱. 인프라 구성·규칙은 [sideinfra/CLAUDE.md](../sideinfra/CLAUDE.md) 가 원본이다.

- 스택: Next.js (App Router) + Supabase (`@supabase/ssr`) + Tailwind CSS v4 + shadcn/ui (base-nova), Vercel 배포 (함수 리전 icn1)
- UI 컴포넌트 추가: `pnpm dlx shadcn@latest add <컴포넌트>` → `components/ui/` 에 코드로 들어온다 (직접 수정 가능)
- Supabase 스키마: `analytalk` — 클라이언트는 `lib/supabase/{server,client}.ts` 가 이 스키마로 고정돼 있다
- **DB 변경은 이 저장소가 아니라 `sideinfra/supabase/migrations` 에 마이그레이션으로 추가한다.**
  모든 테이블은 RLS 를 켜고 정책을 둔다
- 로컬: `cp .env.example .env.local` 후 sideinfra 에서 `supabase status -o env` 값 입력 → `pnpm dev`
- 확인: `/api/health` 가 `{"db":"ok"}` 를 돌려줘야 한다
