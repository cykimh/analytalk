// dev 미리보기용 가짜 데이터. 대화·통계·리포트는 데모 리포트(lib/demo: /demo와 같은 가짜 단톡방 · 손으로 쓴 리포트)를 그대로 쓰고,
// 여기에는 dev 화면에만 필요한 것(가짜 대화 id·쓰는 중 상태·진행 메모)만 둔다. 실제 이름·대화는 없다
import type { ConversationView, Note, StatusView } from "@/components/episode/model";
import type { SharedReportData } from "@/components/episode/SharedReport";
import { demoMessages, demoNames, demoReport, demoStats } from "@/lib/demo/report";

export const PREVIEW_ID = "00000000-0000-4000-8000-000000000000";

const messages = demoMessages;
const stats = demoStats;
const names = demoNames;
export const previewReport = demoReport;

export const previewConversation: ConversationView = {
  concept: "group",
  kind: "group",
  tone: "fact",
  displayNames: names,
  stats,
  cutoffAt: new Date(messages[0].ts).toISOString(),
  msgSent: messages.length,
  expiresAt: "2026-12-25T03:00:00.000Z",
  shared: false,
  // 쓰는 중: 대화 홈 미리보기가 진행 카드를 보여 준다(리포트 화면은 previewReadyConversation)
  report: { status: "running", content: null, errorCode: null },
};

/** 다 쓴 리포트가 있는 대화(리포트 읽기 미리보기) */
export const previewReadyConversation: ConversationView = {
  ...previewConversation,
  report: { status: "done", content: previewReport, errorCode: null },
};

export const previewStatus: StatusView = {
  paused: false,
  report: { status: "running", progress: null, errorCode: null },
};

export const previewNotes: Note[] = previewReport.reading_notes;

export const previewShared: SharedReportData = {
  concept: "group",
  tone: "fact",
  displayNames: names,
  stats,
  report: previewReport,
};
