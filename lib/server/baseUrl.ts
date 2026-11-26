// 서버가 공유 링크 같은 절대 주소를 만들 때 쓰는 origin. 요청이 들어온 origin을 그대로 쓴다.
// VERCEL_URL은 배포마다 바뀌는 주소라 쓰지 않는다.
import "server-only";

export function resolveBaseUrl(reqUrl: string): { baseUrl: string } {
  return { baseUrl: new URL(reqUrl).origin };
}
