// dev 미리보기용 가짜 데이터. 표시 이름은 test/syntheticChat의 "멤버01"…이고 실제 이름·대화는 없다.
// 통계는 진짜 computeStats로 세고, 리포트는 손으로 쓴 StoredReport({{stat:…}} 자리표시자·근거 인용 포함)다
import type { ConversationView, Note, StatusView } from "@/components/episode/model";
import type { SharedReportData } from "@/components/episode/SharedReport";
import { topPeople } from "@/components/stats/format";
import type { StoredReport } from "@/lib/llm/schema";
import { computeStats } from "@/lib/stats/compute";
import { syntheticGroupChat } from "@/test/syntheticChat";

export const PREVIEW_ID = "00000000-0000-4000-8000-000000000000";

const messages = syntheticGroupChat(6, 16, 2025);
const stats = computeStats(messages);
const names = topPeople(stats, 6).people;
const [top, second, third] = names;

/** 근거 인용(가짜 대화의 줄 그대로) */
const evidence = (id: string, sender: string, at: string, quote: string) => ({ id, msg_id: `m${id.slice(1)}`, sender, at, quote });

/** 문단 하나(근거 id) */
const para = (key: string, text: string, evidence_ids: string[] = []) => ({ key, text, evidence_ids });

/** v2.2 모양: 잔소리하는 친구 구성(오프닝 → 멤버별 잔소리 카드 → 방 전체 → 마지막 한마디), 섹션마다 문단 3~5개 */
export const previewReport: StoredReport = {
  safety: { flag: "none" },
  declined_topics: [],
  reading_notes: [
    { range: "01-02~03-30", note: "{{stat:total}}개를 처음부터 읽었다" },
    { range: "04-01~08-28", note: "밤 메시지가 늘어난 여름을 지났다" },
  ],
  headline: "저녁 메뉴로 시작해 새벽까지 가는 방에 하는 잔소리",
  dek: "{{stat:longestStreakDays}} 내리 떠든 방이다. 다 지켜봤다. 한 사람씩 할 말이 있다.",
  sections: [
    {
      part: "nag_open",
      icon: "🙄",
      title: "또 저녁 메뉴로 시작한다",
      about: "group",
      paragraphs: [
        para("p1", "이 방의 하루는 늘 같은 질문으로 시작한다. 저녁 뭐 먹냐고. 답은 매번 다르지만 질문은 한 글자도 안 바뀐다. 다 보여.", ["e1"]),
        para("p2", `메뉴가 정해지는 일은 드물다. ${second}이 사진을 올리고, ${third}이 웃고, 이야기는 어느새 주말 약속으로 넘어간다. 메뉴는 그대로 미정이다.`),
        para("p3", "그래도 이 방은 하루도 그냥 넘어가지 않는다. 누군가는 꼭 먼저 말을 건다. 그건 인정. 이제 한 사람씩 잔소리 들어간다."),
      ],
      evidence: [evidence("e1", top, "2025-01-03T19:12:00+09:00", "오늘 저녁 뭐 먹을까?")],
    },
    {
      part: "nag_cards",
      icon: "📣",
      title: `${top}, 질문만 하고 답은 안 듣는다`,
      about: top,
      paragraphs: [
        para("p1", `질문은 제일 많이 던진다. 대답이 오기도 전에 다음 질문이 나간다. ${top}의 지분이 {{stat:share.${top}}}인 이유가 다 있다.`, ["e1"]),
        para("p2", `약속을 처음 꺼내는 것도 ${top}이다. 날짜를 정하는 건 끝까지 남한테 넘긴다. 또 그런다.`),
        para("p3", "새벽에도 사진이 올라온다. 잘 시간에 왜 맛집 사진이냐고. 다음 날 아침엔 아무 일 없었다는 듯 다시 인사한다."),
        para("p4", `그래도 ${top}이 조용한 날엔 방 전체가 조용하다. 불을 켜는 건 늘 ${top}이다. 그건 인정.`),
      ],
      evidence: [evidence("e1", top, "2025-01-03T19:12:00+09:00", "오늘 저녁 뭐 먹을까?")],
    },
    {
      part: "nag_cards",
      icon: "📸",
      title: `${second}, 대답 대신 사진`,
      about: second,
      paragraphs: [
        para("p1", `말수는 적은데 먼저 말을 거는 건 ${second}이다. 조용하던 방에 첫마디를 던지고는 정작 대화가 붙으면 사라진다.`, ["e1"]),
        para("p2", "주말 약속은 꼭 꺼낸다. 다 같이 보자고. 그 다음 날짜 이야기에는 웃음 한 줄로 답한다. 날짜는 끝까지 안 나왔다. 다 보여."),
        para("p3", `그래도 ${second}의 첫마디가 없었으면 이 방의 주말은 없었다. 판은 늘 ${second}이 깐다.`),
      ],
      evidence: [evidence("e1", second, "2025-02-11T21:40:00+09:00", "주말에 다 같이 보자ㅎㅎ")],
    },
    {
      part: "nag_room",
      icon: "🌙",
      title: "새벽까지 왜들 안 자는 건지{{stat:nope}}",
      about: "group",
      paragraphs: [
        para("p1", "밤 메시지가 {{stat:nightRatio}}인 방이다. 해가 지면 비로소 시작한다. 새벽까지 왜들 안 자는 건지.", ["e1"]),
        para("p2", `큰일이 터진 날엔 다들 같은 말만 한다. 대박, 진짜, 어떻게. 자세한 얘기는 늘 내일로 미룬다. ${third}이 그 내일을 제일 많이 약속한다.`),
        para(
          "p3",
          `웃음은 짧게 안 끊는다. ㅋ를 길게 늘어뜨리는 건 다 같은데, 물음표는 ${third}만 유난히 많다. 궁금한 건 못 참는 방이다.`,
        ),
      ],
      evidence: [
        evidence(
          "e1",
          third,
          "2025-07-19T23:58:00+09:00",
          "아 그거 나도 들었어 대박이다 진짜로 어떻게 그런 일이 있지\n내일 자세히 얘기해 줘",
        ),
      ],
    },
    {
      part: "nag_last",
      icon: "✋",
      title: "마지막 한마디",
      about: "group",
      paragraphs: [
        para("p1", `${top}, ${second}, ${third}. 저녁 메뉴는 이제 좀 정하고, 주말 약속은 날짜까지 박아라. 새벽 수다는 조금만 일찍 끝내고.`, ["e1"]),
        para("p2", "그래도 하루도 안 빠지고 서로를 부르는 방은 흔하지 않다. 내일도 누군가는 저녁 뭐 먹냐고 묻겠지. 그건 계속해도 된다."),
        para("p3", "잔소리는 여기까지. 다 보고 있었다."),
      ],
      evidence: [evidence("e1", second, "2025-02-11T21:40:00+09:00", "주말에 다 같이 보자ㅎㅎ")],
    },
  ],
};

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
