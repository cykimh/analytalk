// 앱 전체의 404: 없는 주소와, notFound()를 부른 곳 중 자기 not-found.tsx가 없는 화면(dev 미리보기 등).
// 루트 레이아웃 안에서 그려져 모눈종이 바탕·글꼴을 그대로 쓴다. 공유 링크(/s/[token])는 app/s/[token]/not-found.tsx
import { MissingPage } from "@/components/episode/MissingPage";
import { RETENTION_DAYS } from "@/lib/config";

export default function NotFound() {
  return (
    <MissingPage title="찾는 페이지가 없어요">
      <p>주소가 맞는지 확인해 주세요.</p>
      <p className="text-ink-soft">받은 공유 링크라면 {RETENTION_DAYS}일이 지났거나 만든 사람이 링크를 폐기했을 수 있어요.</p>
    </MissingPage>
  );
}
