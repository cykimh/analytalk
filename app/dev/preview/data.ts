// dev 미리보기용 가짜 데이터. 표시 이름은 test/syntheticChat의 "멤버01"…이고 실제 이름·대화는 없다.
// 통계는 진짜 computeStats로 세고, 편은 손으로 쓴 StoredEpisode({{stat:…}} 자리표시자·근거 인용·다음 편 예고 포함)다
import type { ConversationView, Note, StatusView } from "@/components/episode/model";
import type { SharedReportData } from "@/components/episode/SharedReport";
import { topPeople } from "@/components/stats/format";
import type { StoredEpisode } from "@/lib/llm/schema";
import { computeStats } from "@/lib/stats/compute";
import { syntheticGroupChat } from "@/test/syntheticChat";

export const PREVIEW_ID = "00000000-0000-4000-8000-000000000000";

const messages = syntheticGroupChat(6, 16, 2025);
const stats = computeStats(messages);
const names = topPeople(stats, 6).people;
const [top, second, third] = names;

/** 근거 인용(가짜 대화의 줄 그대로) */
const evidence = (id: string, sender: string, at: string, quote: string) => ({ id, msg_id: `m${id.slice(1)}`, sender, at, quote });

export const previewEpisode: StoredEpisode = {
  episode: 1,
  safety: { flag: "none" },
  declined_topics: [],
  reading_notes: [
    { range: "01-02~03-30", note: "{{stat:total}}개를 처음부터 읽었다" },
    { range: "04-01~08-28", note: "밤 메시지가 늘어난 여름을 지났다" },
  ],
  headline: "{{stat:total}}개의 메시지가 쌓인 방의 연대기",
  dek: "{{stat:longestStreakDays}} 연속으로 이어진 수다, 그 첫날부터 지금까지를 한 장에 붙였어요",
  sections: [
    {
      icon: "📅",
      title: "저녁 약속으로 문을 연 방",
      about: "group",
      paragraphs: [
        {
          key: "p1",
          text: `이 방의 첫 화제는 늘 저녁 메뉴였어요. 가장 말이 많은 ${top}님이 전체 대화의 {{stat:share.${top}}}를 맡았고, 질문을 던지면 대개 {{stat:replyMedianMs.${second}}} 안에 누군가 답했어요.`,
          evidence_ids: ["e1"],
        },
        {
          key: "p2",
          text: `${second}님은 말수는 적어도 대화를 먼저 여는 쪽이었어요. 조용하던 방에 {{stat:initiations.${second}}}번이나 먼저 말을 걸었죠.`,
          evidence_ids: ["e2"],
        },
      ],
      evidence: [
        evidence("e1", top, "2025-01-03T19:12:00+09:00", "오늘 저녁 뭐 먹을까?"),
        evidence("e2", second, "2025-02-11T21:40:00+09:00", "주말에 다 같이 보자ㅎㅎ"),
      ],
    },
    {
      icon: "🌙",
      title: "밤이 길어진 계절{{stat:nope}}",
      about: "group",
      paragraphs: [
        {
          key: "p1",
          text: "밤 10시부터 새벽 5시 사이에 오간 메시지가 {{stat:nightRatio}}예요. 하루 중 가장 시끌벅적했던 날에는 {{stat:busiestDay.count}}개가 쏟아졌어요.",
          evidence_ids: ["e3"],
        },
      ],
      evidence: [
        evidence(
          "e3",
          third,
          "2025-07-19T23:58:00+09:00",
          "아 그거 나도 들었어 대박이다 진짜로 어떻게 그런 일이 있지\n내일 자세히 얘기해 줘",
        ),
      ],
    },
    {
      icon: "😂",
      title: "ㅋ의 계보",
      about: "group",
      paragraphs: [
        {
          key: "p1",
          text: `웃음은 짧게 끊기보다 길게 이어지는 편이었어요. ${third}님의 물음표 비율은 {{stat:questionRate.${third}}}로, 궁금한 건 바로 묻는 사람이었죠.`,
          evidence_ids: [],
        },
      ],
      evidence: [],
    },
  ],
  next_teaser: `2편 멤버 캐릭터 카드: 답장이 {{stat:replyMedianMs.${top}}} 걸리는 사람은 누구일까요?`,
};

const second_episode: StoredEpisode = {
  ...previewEpisode,
  episode: 2,
  headline: "멤버 캐릭터 카드",
  dek: "누가 먼저 말을 걸고, 누가 마무리하는지",
  sections: previewEpisode.sections.slice(0, 1),
  next_teaser: "3편 명장면",
};

export const previewConversation: ConversationView = {
  concept: "group",
  kind: "group",
  displayNames: names,
  stats,
  cutoffAt: new Date(messages[0].ts).toISOString(),
  msgSent: messages.length,
  expiresAt: "2026-12-25T03:00:00.000Z",
  shared: false,
  shareScope: null,
  shareHidden: [],
  episodes: [
    { n: 1, status: "done", content: previewEpisode, errorCode: null },
    { n: 2, status: "partial", content: second_episode, errorCode: null },
    { n: 3, status: "running", content: null, errorCode: null },
    { n: 4, status: "failed", content: null, errorCode: "retryable" },
  ],
};

export const previewStatus: StatusView = {
  paused: false,
  episodes: previewConversation.episodes.map((e) => ({ n: e.n, status: e.status, progress: null, errorCode: e.errorCode })),
};

export const previewNotes: Record<number, Note[]> = {
  1: previewEpisode.reading_notes,
  2: [{ range: "01-02~06-30", note: `${second}님이 먼저 말을 건 날을 셌다` }],
  3: [{ range: "02-14~02-14", note: "가장 많이 웃은 하루를 찾는 중" }],
};

export const previewShared: SharedReportData = {
  concept: "group",
  displayNames: names,
  stats,
  episodes: [
    { n: 1, content: previewEpisode },
    { n: 2, content: second_episode },
  ],
};
