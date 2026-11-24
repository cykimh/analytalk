# analytalk

공통 인프라(sideinfra) 위의 앱. 인프라 구성·규칙은 [sideinfra/CLAUDE.md](../sideinfra/CLAUDE.md) 가 원본이다.

- 스택: Next.js 16 (App Router) + Supabase (`@supabase/supabase-js`, 서버 전용) + Tailwind CSS v4 + shadcn/ui (base-nova), Vercel 배포 (함수 리전 icn1)
- UI 컴포넌트 추가: `pnpm dlx shadcn@latest add <컴포넌트>` → `components/ui/` 에 코드로 들어온다 (직접 수정 가능)
- Supabase 스키마: `analytalk` (`lib/app.ts`의 `APP_SCHEMA`). 브라우저는 DB에 붙지 않고 API만 부른다
  - 서버 DB 접근은 `lib/server/privileged.ts`(service_role secret 키 클라이언트, `server-only`)와 `lib/server/repo.ts`(`AppRepo`)를 거친다. 라우트 본체 `lib/server/handlers/*`는 `lib/server/route.ts`가 `getRepo()`로 넘긴 `deps.repo`만 쓰고, 서버 페이지는 `getRepo()`를 직접 부른다
  - `getRepo()`: E2E 테스트 모드 → 고정 초대 코드 `memoryRepo`, secret 키 있음 → Supabase, 개발에서 키 없음 → `memoryRepo`(재시작하면 사라짐), 프로덕션에서 키 없음 → 503
  - `memoryRepo`(E2E·키 없는 개발·테스트용)는 `sideinfra/supabase/migrations/*_analytalk_core.sql`의 함수 규칙을 재현한다. 규칙을 바꾸면 SQL·pgTAP·`repo.ts`·`repo.test.ts`를 함께 고친다
- **DB 변경은 이 저장소가 아니라 `sideinfra/supabase/migrations` 에 마이그레이션으로 추가한다.**
  모든 테이블은 RLS 를 켠다. analytalk 테이블은 정책이 0개라 service_role(secret 키)만 읽고 쓴다
- 로컬: `cp .env.example .env.local` 후 sideinfra 에서 `supabase status -o env` 값(API_URL·SECRET_KEY) 입력 → `pnpm dev`
  - 로컬 DB: sideinfra 에서 `supabase stop && supabase start`를 한 번 해야 로컬 PostgREST가 `analytalk` 스키마를 노출한다(config.toml 변경 반영)
- 확인: `/api/health` 가 `{"db":"ok"}` 를 돌려줘야 한다

## analytalk 규칙

- 명령: `pnpm test`(vitest), `pnpm typecheck`, `pnpm test:e2e`(Playwright, dev 3100 / prod 3200), `pnpm check:fixtures`, `pnpm invite:add|revoke`(`--prod`는 `.env.production.local` 사용), `pnpm measure`, `pnpm eval`
- e2e: 처음 한 번 `pnpm exec playwright install chromium webkit`. 기본은 dev 서버(3100), prod 프로젝트(CSP·헤더, `security.spec.ts`)는 `PW_PROD=1 pnpm test:e2e --project=prod-chromium --project=prod-webkit`
- 저장 금지: 원본 대화 파일·전체 파싱 결과는 브라우저 밖으로 나가지 않는다. 페이로드의 `transcript`·`anchors`는 서버 메모리에서만 다루고 DB·Storage·로그(`console.*` 포함)에 남기지 않는다. 실제 이름은 저장·전송하지 않는다
- 실제 대화 파일은 커밋하지 않는다(공개 저장소). 테스트 파일은 줄 모양만 남긴 가짜 대화다
- 테스트 모드(E2E)는 `ANALYTALK_E2E === "1" && !process.env.VERCEL` 일 때만 켜진다. Vercel에서는 절대 켜지지 않는다
- 비밀값은 Vercel Sensitive 변수로 둔다. 에이전트는 `.env*`를 읽거나 쓰지 않는다(`.env.example`만 수정)

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
