# analytalk 디자인 — 스크랩북 콜라주

친구들이 공유 링크로, 대부분 휴대폰에서 여는 리포트를 **모눈종이 다이어리 한 장**처럼 보이게 한다.
종이 카드를 테이프로 붙이고, 제목에 형광펜을 긋고, 핵심 숫자는 폴라로이드로, 이름·컨셉은 종이 스티커로 붙인다.

UI 작업 전에 이 문서를 읽고 따른다. 값의 원본은 코드다: 토큰은 `app/globals.css`, 순서 규칙은 `components/scrap/tilt.ts`.

## 범위

| 화면 | 적용 |
| --- | --- |
| 대화 홈 `/c/[id]`, 편 읽기 `/c/[id]/e/[n]`, 진행 `/c/[id]/steps`, 공유 `/s/[token]` | 콜라주 전부(종이·기울기·테이프·형광펜·폴라로이드·스티커·메모지·크레파스 막대), 430px 다이어리 틀 |
| 없는 주소·사라진 공유 링크(404, `app/not-found.tsx`·`app/s/[token]/not-found.tsx`) | 430px 다이어리 틀, 떼어 낸 사진 빈자리(점선 + 테이프), 형광펜 제목 종이 한 장, [처음 화면으로] (`MissingPage`) |
| 홈 `/`, 초대 코드, 업로드 `/new`, 안내 `/about` | 모눈종이 바탕과 글꼴만. 업로드의 통계 미리보기는 `StatsDashboard look="plain"`(둥근 카드, 색은 리포트와 같은 크레파스) |

## 토큰 (`app/globals.css`)

| 이름 | 값 | 쓰임 |
| --- | --- | --- |
| `--paper` | `#FDFBF7` | 앱 전체 바탕. `body`에 20px 모눈(`--grid-line` `#EDE5D8`, 1px) |
| `--sheet` | `#FFFDF9` | 붙인 종이 카드(`bg-sheet`, shadcn `--card`) |
| `--ink` | `#2D2926` | 글자·주 버튼·포커스 테두리. 바탕 위 13.9:1 |
| `--ink-soft` | `#6A5F55` | 보조 글자(`text-ink-soft`, shadcn `--muted-foreground`). 바탕 6.0:1, 형광펜·스티커 위 5:1 이상 |
| `--hl-yellow` / `--hl-mint` | `#FFF3A3` / `#CDEFE3` | 형광펜 |
| `--tape-pink·sky·lime·lilac·butter` | 알파 0.58~0.66 파스텔 | 마스킹 테이프(`bg-tape-*`) |
| `--sticker-butter·pink·mint·sky·lilac·kraft` | 불투명 파스텔 | 스티커·폴라로이드 사진 칸·메모지 종이(`bg-sticker-*`) |
| `--note-line` | `#E9DFCD` | 근거 메모지의 줄 |
| `--shadow-paper` / `--shadow-sticker` | 옅은 갈색 그림자 | 종이가 살짝 뜬 정도만 |
| `--destructive` | `#B23A2B` | 삭제·폐기 |

- shadcn 변수(`--background`·`--card`·`--muted`·`--border`·`--primary`…)는 모두 위 종이 색으로 이어 둔다. 새 shadcn 컴포넌트도 따로 칠하지 않아도 종이 색을 쓴다
- 차트 색(`components/stats/charts.tsx`): `CRAYON_SERIES`(귤·청록·딸기·개나리·풀잎·라벤더·코코아·흐린 하늘, 사람 순서대로), `CRAYON_SEQUENTIAL`(종이 → 벽돌, 달력 히트맵). 차가운 파랑은 쓰지 않는다
- 다크 모드는 없다. `color-scheme: light`이고, `dark:` 변형은 `.dark` 클래스에 묶여 있어 켜지지 않는다

## 글꼴 (`app/fonts.ts`)

**Pretendard 하나만 쓴다** (400·700, OFL, `next/font/local`, npm `pretendard`의 KS X 1001 서브셋, 클래스 `font-sans` 기본). 제목·본문·스티커·캡션·숫자 모두. 손글씨체는 쓰지 않는다(2026-11-25 사용자: "리포트인데 너무 장난스럽다, 글씨는 잘 보이게")

| 쓰임 | 크기·굵기 |
| --- | --- |
| 표지·편 제목 h1 | 28px(`text-[1.75rem]`) 700, `tracking-tight` (홈 로고 32px) |
| 섹션 제목 h2 | 20~22px(`text-[1.25rem]`~`text-[1.375rem]`) 700, `tracking-tight` |
| 카드·차트 제목 h3 | 18px(`text-[1.125rem]`) 700 |
| 작은 제목·메모(“다음 편 예고”, “← 대화 홈”, 폴라로이드 캡션) | 16px(`text-base`) |
| 스티커 | 부모 크기, 700, 자간 -0.01em |

- 빌드 때 받아 `/_next/static/media`에서 낸다. CSP `font-src`는 `default-src 'self'`라 외부 글꼴 주소를 쓰면 막힌다
- 미리 받는(preload) 글꼴은 Pretendard Regular 한 파일뿐이다. Pretendard Bold는 굵은 글자가 나올 때 받는다. 글꼴을 더하면 빌드 후 `.next/server/next-font-manifest.json`에서 라우트마다 preload가 1개인지 본다
- 리포트 본문은 Pretendard **17px**(`text-[1.0625rem]`), 줄 간격 1.8. **문장으로 읽는 글(설명·안내·목록·공유 패널 안내·라디오 설명·차트 설명)은 모든 화면에서 16px(`text-base`) 이상.** 12~14px은 날짜·단위·축·고지 같은 짧은 라벨에만 쓴다
- 숫자(통계·시각·날짜)는 `tabular-nums`. 리포트 화면은 `PageFrame` 전체에 걸어 둔다. 큰 숫자는 굵게
- 모델이 쓴 글의 통계 값은 바로 뒤에 붙은 조사·문장부호(6자까지)와 한 덩어리로 줄을 바꾼다(`glueTails`, “23%로,”가 “23%” / “로,”로 갈리지 않게)
- 서브셋에 없는 드문 음절은 시스템 고딕으로 떨어진다

## 레이아웃

- 리포트 화면은 `PageFrame`(`components/episode/PageState.tsx`): `max-w-[430px] mx-auto px-4`, 카드 사이 `gap-7`. 기운 카드·테이프가 옆으로 삐져나와도 가로 스크롤이 생기지 않게 `overflow-x-clip`
- 카드는 한 줄로 쌓는다. 430px 안에서 `sm:grid-cols-2`를 쓰지 않는다(브레이크포인트는 화면 폭 기준이라 다이어리 폭과 어긋난다)
- 글은 왼쪽 정렬. 가운데 정렬은 폴라로이드 캡션과 진행 화면의 노란 메모지만
- 한글은 `word-break: keep-all` + `overflow-wrap: break-word`(앱 전체). keep-all에서는 띄어 쓰지 않은 긴 글(ㅋ 줄, 붙여 쓴 문장)이 끊을 곳 없는 한 단어라서, grid 칸이 그 폭만큼 넓어져 카드 밖으로 잘린다. 그래서
  - 글이 든 grid는 `grid-cols-1`(`minmax(0,1fr)`)로 칸 폭을 부모에 묶는다(`PageFrame`·`ReportCapture`·편 카드·메모지·피드백 목록)
  - 모델이 쓴 글과 인용(헤드라인·dek·섹션 제목·문단·예고·진행 메모·인용·보낸 사람)은 `wrap-anywhere`(`overflow-wrap: anywhere`)
  - `PageFrame`이 가로를 잘라서 안에서 넘친 글은 문서 가로 스크롤로 드러나지 않는다. e2e `expectNoHorizontalScroll`은 문서·`main`의 넘침과, 보이는 글자가 화면과 잘라 내는 조상 안에 있는지까지 본다(375px, ㅋ 줄 인용·붙여 쓴 문단 포함)

## 콜라주 조각 (`components/scrap/`)

| 조각 | 규칙 |
| --- | --- |
| `Paper` | 붙인 종이 한 장. 모서리 거의 각짐(2~4px), 옅은 그림자. `tilt`는 `alternate(i)`로 −1.2° / +1° 번갈아. **긴 본문이 든 카드(편 섹션·공유 패널·진행 기록)는 `calm`으로 ±0.5° 이하**. `tone`: `sheet`(흰 종이)·`butter`(노란 메모지: 다음 편 예고·진행 통계)·`kraft`(크라프트지: 작은 숫자 칸) |
| `MaskingTape` | `Paper`의 `tape={tapeAt(i)}`로 붙인다. 색 다섯 가지와 자리(가운데·왼쪽 모서리·오른쪽 모서리)를 서로 다른 주기로 돌려, 이웃한 카드의 테이프는 색도 자리도 다르다. 반투명(`mix-blend-mode: multiply`), 양 끝이 들쭉날쭉, 살짝 기움. 모서리 테이프는 가늘고 짧게 모서리에 비껴 붙여 첫 줄 글자를 덮지 않고, 카드 바깥으로 8px만 나가 375px 화면 끝에서 잘리지 않는다 |
| `Highlight` | 제목 글자 뒤 아래쪽 절반의 단색 띠(하드 스톱). `highlightAt(i)`로 노랑부터 민트와 번갈아. h1·h2 제목에만 긋고, 차트 카드 제목(h3)에는 긋지 않는다 |
| `Polaroid` / `PolaroidStrip` | 흰 테두리, 아래 여백이 두꺼운 사진. 사진 칸에 큰 숫자(Pretendard 굵게, tabular, 칸 폭에 맞춰 크기), 아래 여백에 캡션(16px). `<dl>` 안에서 읽는 순서는 캡션 → 숫자, 화면은 숫자가 위 |
| `Sticker` | 다이컷 종이 스티커: 둥근 모서리 + 흰 테두리 3px, 굵게, ±2° 안에서 기움(`stickerTiltAt`). 긴 글자는 한 줄 말줄임 |
| `TornNote` | 근거 인용 메모지: 위아래가 찢긴 종이, 옅은 줄(28px), 왼쪽 위 큰 따옴표. 캡션(보낸 사람 · 시각) → 인용 순서. 짧은 글이라 ±0.8° 안에서 기움 |
| `.crayon` | 크레파스 단색 막대: 한 색 위에 밀랍 같은 흰 결(SVG 노이즈, `data:` 이미지)과 고르지 않은 모서리. 그라데이션을 쓰지 않는다 |

리포트 화면이 쓰는 조합:

- 표지 제목(`SERIES_TITLE`: “단톡방 연재”·“둘의 대화 연재”)은 굵은 제목 + 노랑 형광펜. 대화 홈과 공유 화면이 같은 제목을 쓴다
- `CoverStickers`(`components/episode`): 컨셉 → 기간(첫 메시지 ~ 마지막 메시지) → 멤버 이름(6명까지, 넘으면 “외 N명”)
- `KpiPolaroids`(`components/stats`): 주고받은 메시지 · 함께한 날(기간 날수, 양 끝 포함) · 가장 뜨거웠던 날(busiestDay 개수와 날짜)
- 섹션 아이콘은 h2 앞의 스티커(`aria-hidden`)
- 통계는 `StatsDashboard look="scrap"`: 차트 카드는 `Paper` + 테이프, 막대는 `.crayon`, 축 글자 12px
- 세로 막대(`Columns`)는 바닥에 옅은 점선 기준선을 깔고, 값이 없거나 0인 칸은 기준선 위 낮은 회색 눈금으로 둔다. 월별 막대는 첫·끝 달(“25년 5월”), ㅋ 길이는 1·4·7·10+ 눈금 글자를 달고, ㅋ 길이는 가장 잦은 길이만 진하게(나머지 옅게)

## `#report-capture` 안과 밖

읽는 리포트(제목 → 본문 → 근거 인용)는 `ReportCapture`(`id="report-capture"`) 하나로 감싼다. 이미지로 저장하는 기능은 아직 없고 구조만 있다.
**공유 패널과 조작 버튼(다시 쓰기·피드백·삭제·공유)은 그 바깥 아래에 둔다.** 한 화면에 하나만 둔다.

| 화면 | 안 | 밖(아래) |
| --- | --- | --- |
| 대화 홈 | 표지(고지·제목·스티커·읽은 범위·삭제 예정일), 폴라로이드 | 편 카드([N편 읽기]·[다시 쓰기]), 공유 패널, 대화 통계, [지금 삭제] |
| 편 읽기 | 편 전체(표지·스티커·폴라로이드·섹션·근거 메모지·다음 편 예고) | 문단 [틀렸어요] 모음(`ParagraphFeedback`), [N+1편 읽기] |
| 진행 | 표지, 정지 안내, 노란 메모지 통계, 편별 진행 기록, 실패 안내 | [1편 읽기]·[대화 홈] |
| 공유 | 표지(고지·스티커), 폴라로이드, 보여 줄 편들 | [나도 해보기] |

“← 대화 홈” 같은 이동 링크와 “일부 문단만 남았어요” 같은 알림은 위쪽 바깥에 둔다.
버튼을 옮길 때는 글자와 역할(role)을 바꾸지 않는다. e2e가 글자·역할·영역 이름(`region "1편"`, `region "공유"`)으로 찾는다.

## 버튼·누르는 영역·포커스

- `Button`(`components/ui/button.tsx`) default는 44px, lg는 48px, 글자 16px. 리포트 화면에서 sm·xs를 쓰지 않는다
- 버튼이 아닌 링크·체크박스·라디오도 누르는 영역을 44px 이상으로(`min-h-11`, 감싼 label에 `py-2.5`). 체크박스·라디오는 18px
- 키보드 포커스는 모든 버튼·링크·입력칸이 같은 2px 잉크 테두리(`outline-2 outline-offset-2 outline-foreground`). 옅은 ring(`ring-ring/50`·`ring-destructive/20`)은 종이 위에서 안 보여 쓰지 않는다

## 하자 / 하지 말자

하자

- 새 카드는 `Paper`로 만들고, 순서 `i`로 `alternate(i)`·`tapeAt(i)`·`highlightAt(i)`를 고른다(손으로 각도·색을 적지 않는다)
- 긴 글 카드는 `calm`. 기울기는 정적으로만 두고 애니메이션을 넣지 않는다
- 숫자는 `tabular-nums`, 모델이 쓴 글은 `StatText`로
- 장식(테이프·스티커 아이콘)은 `aria-hidden`
- 화면을 바꿨으면 `/dev/preview`에서 375px·430px로 보고, `pnpm test:e2e`의 375px 가로 스크롤 테스트를 돌린다

하지 말자

- 다크 모드, 네온, 반짝이는 그라데이션, 차가운 파랑, 대시보드형 카드 격자(2열·4열 타일 벽)
- 같은 테이프·같은 각도를 이웃 카드에 반복하기, 모든 제목에 형광펜 긋기
- 본문 16px 미만, 대비 4.5:1 미만 글자, 본문 카드 0.5° 넘게 기울이기
- 외부 글꼴·이미지 주소(CSP가 막는다). 장식 이미지는 CSS·`data:` SVG로
- `#report-capture` 안에 버튼·공유 패널 넣기

## 미리보기

```
pnpm dev        # 그 뒤
http://localhost:3000/dev/preview            # 조각 모음(종이·테이프·형광펜·스티커·폴라로이드·메모지·크레파스)
http://localhost:3000/dev/preview/home       # 대화 홈
http://localhost:3000/dev/preview/episode    # 편 읽기
http://localhost:3000/dev/preview/steps      # 진행
http://localhost:3000/dev/preview/share      # 공유 화면
```

- 진짜 화면 컴포넌트(`ConversationHomeView`·`EpisodeReaderView`·`StepsFeedView`·`SharedReport`)에 가짜 데이터를 넣어 그린다:
  `test/syntheticChat.ts`의 가짜 단톡방(“멤버01”…) → `computeStats`, 손으로 쓴 편(`app/dev/preview/data.ts`, `{{stat:…}}`·근거 인용·다음 편 예고 포함)
- 프로덕션 빌드에서는 404(`app/dev/preview/gate.ts`). 링크로 들어오는 곳이 없고, 초대 게이트(proxy.ts)는 `/new`·`/c/*`만 막아 dev에서 바로 열린다
- 버튼은 진짜 것이다: [다시 쓰기]는 아무것도 보내지 않고 안내만 하고, 공유는 없는 대화라 실패하며, [지금 삭제]는 404를 “이미 지워짐”으로 보고 처음 화면으로 간다
