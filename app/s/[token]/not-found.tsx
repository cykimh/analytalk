// 공유 링크가 열리지 않을 때(page.tsx의 notFound): 모르는 토큰·폐기한 링크·30일이 지나 지워진 대화.
// 어느 경우인지는 알려 주지 않는다(토큰이 있었는지 드러내지 않는다). 상태 코드는 404 그대로다
import { MissingPage } from "@/components/episode/MissingPage";
import { RETENTION_DAYS } from "@/lib/config";

export default function SharedNotFound() {
  return (
    <MissingPage title="링크가 사라졌어요">
      <p>
        공유 링크는 대화와 함께 {RETENTION_DAYS}일 뒤에 지워지고, 만든 사람이 폐기하면 바로 닫혀요. 보낸 사람에게 새 링크를
        부탁해 주세요.
      </p>
    </MissingPage>
  );
}
