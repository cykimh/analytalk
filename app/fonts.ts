// 앱 글꼴은 Pretendard 하나(제목·본문 모두). 빌드 때 받아 /_next/static/media 에서 직접 낸다(CSP font-src는 default-src 'self'를 따른다).
// 공유 링크를 휴대폰 데이터로 여는 사람이 많아서, 첫 화면에 미리 받는(preload) 글꼴은 Pretendard Regular 한 파일뿐이다.
// 확인: 빌드 후 .next/server/next-font-manifest.json의 라우트별 목록(라우트마다 1개)
// - Pretendard(OFL): npm 패키지의 KS X 1001 서브셋(자주 쓰는 한글 2,350자 + 라틴·기호)을 굵기 두 개만 쓴다.
//   서브셋에 없는 드문 음절은 시스템 고딕으로 떨어진다.
//   preload는 호출 단위라 굵기마다 따로 부르고, Bold도 같은 글꼴 이름(font-family: pretendard)으로 선언한다.
//   이름이 다르면 굵은 글자가 Regular를 억지로 굵게 그린다. Bold는 굵은 글자가 화면에 나올 때 받는다.
//   src는 글자 그대로 쓴다(next/font가 빌드 때 정적으로 읽어서 템플릿 문자열·상수는 못 읽는다)
import localFont from "next/font/local";

export const pretendard = localFont({
  src: "../node_modules/pretendard/dist/web/static/woff2-subset/Pretendard-Regular.subset.woff2",
  weight: "400",
  style: "normal",
  display: "swap",
  declarations: [{ prop: "font-family", value: "pretendard" }],
  variable: "--font-pretendard",
  fallback: ["Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", "system-ui", "sans-serif"],
});

/** 위 pretendard와 같은 글꼴의 700. 따로 쓰는 클래스는 없고, @font-face만 들이려고 variable을 html에 단다 */
export const pretendardBold = localFont({
  src: "../node_modules/pretendard/dist/web/static/woff2-subset/Pretendard-Bold.subset.woff2",
  weight: "700",
  style: "normal",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: "font-family", value: "pretendard" }],
  variable: "--font-pretendard-bold",
});
