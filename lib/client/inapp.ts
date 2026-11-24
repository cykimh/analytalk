// 카카오톡 인앱 브라우저 감지와 외부 브라우저로 여는 주소. DOM 없이 서버·브라우저 공용.
// 인앱 브라우저는 파일 선택이 막히거나 쿠키가 외부 브라우저와 따로 놀아서 외부로 열라고 안내한다.

export function isKakaoInApp(ua: string): boolean {
  return /KAKAOTALK/i.test(ua);
}

/** 카카오톡이 이 주소를 기본 브라우저로 연다 */
export function openExternalUrl(url: string): string {
  return `kakaotalk://web/openExternal?url=${encodeURIComponent(url)}`;
}
