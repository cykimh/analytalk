// 앱 글꼴 두 벌. 둘 다 빌드 때 받아 /_next/static/media 에서 직접 낸다(CSP font-src는 default-src 'self'를 따른다).
// 공유 링크를 휴대폰 데이터로 여는 사람이 많아서, 첫 화면에 미리 받는(preload) 글꼴은 Pretendard Regular 한 파일뿐이다.
// 확인: 빌드 후 .next/server/next-font-manifest.json의 라우트별 목록(라우트마다 1개)
// - 개구체(Gaegu, OFL): 제목·스티커·폴라로이드 캡션·손글씨 메모. 구글 폰트가 글자 범위(unicode-range)마다 나눈 조각(약 90개)을
//   next/font가 모두 받아 두지만 미리 받지는 않는다(preload: false). 브라우저는 화면에 나온 글자가 든 조각만 받는다
// - Pretendard(OFL): 본문. npm 패키지의 KS X 1001 서브셋(자주 쓰는 한글 2,350자 + 라틴·기호)을 굵기 두 개만 쓴다.
//   서브셋에 없는 드문 음절은 시스템 고딕으로 떨어진다.
//   preload는 호출 단위라 굵기마다 따로 부르고, Bold도 같은 글꼴 이름(font-family: pretendard)으로 선언한다.
//   이름이 다르면 굵은 글자가 Regular를 억지로 굵게 그린다. Bold는 굵은 글자가 화면에 나올 때 받는다.
//   src는 글자 그대로 쓴다(next/font가 빌드 때 정적으로 읽어서 템플릿 문자열·상수는 못 읽는다)
import { Gaegu } from "next/font/google";
import localFont from "next/font/local";

export const gaegu = Gaegu({
  weight: ["400", "700"],
  display: "swap",
  preload: false,
  variable: "--font-gaegu",
});

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
