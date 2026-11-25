// 앱 글꼴 두 벌. 둘 다 빌드 때 받아 /_next/static/media 에서 직접 낸다(CSP font-src는 default-src 'self'를 따른다).
// - 개구체(Gaegu, OFL): 제목·스티커·폴라로이드 캡션·손글씨 메모. 구글 폰트가 글자 범위(unicode-range)마다 나눈 조각을
//   next/font가 모두 받아 두고, 브라우저는 화면에 나온 글자의 조각만 받는다. 미리 받는 것(preload)은 라틴 조각뿐이다
// - Pretendard(OFL): 본문. npm 패키지의 KS X 1001 서브셋(자주 쓰는 한글 2,350자 + 라틴·기호)을 굵기 두 개만 쓴다.
//   서브셋에 없는 드문 음절은 시스템 고딕으로 떨어진다
import { Gaegu } from "next/font/google";
import localFont from "next/font/local";

export const gaegu = Gaegu({
  weight: ["400", "700"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-gaegu",
});

export const pretendard = localFont({
  src: [
    { path: "../node_modules/pretendard/dist/web/static/woff2-subset/Pretendard-Regular.subset.woff2", weight: "400", style: "normal" },
    { path: "../node_modules/pretendard/dist/web/static/woff2-subset/Pretendard-Bold.subset.woff2", weight: "700", style: "normal" },
  ],
  display: "swap",
  variable: "--font-pretendard",
  fallback: ["Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", "system-ui", "sans-serif"],
});
