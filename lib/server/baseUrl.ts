// 서버가 자기 자신(내부 편 호출)을 부를 주소. 요청이 들어온 origin을 그대로 쓴다.
// VERCEL_URL은 배포마다 바뀌는 주소라 쓰지 않는다. 배포 보호가 켜져 있으면 자동화 우회 헤더를 붙인다.
import "server-only";

export function resolveBaseUrl(reqUrl: string): { baseUrl: string; headers: Record<string, string> } {
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  return {
    baseUrl: new URL(reqUrl).origin,
    headers: bypass ? { "x-vercel-protection-bypass": bypass } : {},
  };
}
