// 데모 리포트 한 편(v2.8): 가짜 단톡방(lib/demo/chat)의 통계와 손으로 쓴 리포트. /demo(로그인 없이, 운영에서도)와 dev 미리보기가 같이 쓴다.
// 실제 데이터·실명은 없다. 리포트는 잔소리하는 친구 말투로 하이라이트 카드·ㅋ 유형·케미 온도·MBTI 추측이 모두 보이게 썼다.
// v2.9: 사람마다 페르소나(명대사는 가짜 대화의 실제 줄)와 관계 카드도 넣었다.
// 숫자는 {{stat:…}}로만 쓰고, 근거와 문단 속 큰따옴표 대사는 가짜 대화에 그대로 있는 말이다(lib/demo/report.test가 검증을 통과하는지 본다).
// dev 전용 코드(app/dev/preview)에 기대지 않는다. 서버 컴포넌트(/demo)가 쓰면 이 모듈은 서버에서만 돈다
import type { StoredPersona, StoredReport } from "@/lib/llm/schema";
import type { ChatMessage } from "@/lib/parse/parse";
import { type ChatStats, computeStats } from "@/lib/stats/compute";
import { DEMO_NAMES, type DemoName, demoChat } from "./chat";

const pad = (n: number) => String(n).padStart(2, "0");
/** epoch ms → "YYYY-MM-DDTHH:mm:00+09:00" */
function isoKst(ts: number): string {
  const d = new Date(ts + 9 * 3_600_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00+09:00`;
}

export const demoMessages: ChatMessage[] = demoChat();
export const demoStats: ChatStats = computeStats(demoMessages);
/** 표시 이름(메시지 많은 순) */
export const demoNames: string[] = [...DEMO_NAMES].sort((a, b) => (demoStats.byPerson[b] ?? 0) - (demoStats.byPerson[a] ?? 0));

/** 근거 인용: 가짜 대화에서 그 사람이 보낸 그 줄(번호·시각은 그 메시지의 것) */
function evidence(id: string, sender: DemoName, text: string, quote = text) {
  const m = demoMessages.find((x) => x.sender === sender && x.text === text);
  if (!m) throw new Error(`[demo] 가짜 대화에 없는 근거: ${id}`);
  return { id, msg_id: `m${m.id}`, quote, sender, at: isoKst(m.ts) };
}
const para = (key: string, text: string, evidence_ids: string[] = []) => ({ key, text, evidence_ids });
/** 명대사: 그 사람이 보낸 메시지 중 text가 든 첫 메시지의 그 부분 */
function quote(sender: DemoName, text: string) {
  const m = demoMessages.find((x) => x.sender === sender && x.text.includes(text));
  if (!m) throw new Error(`[demo] 가짜 대화에 없는 명대사: ${sender}`);
  return { msg_id: `m${m.id}`, quote: text, sender, at: isoKst(m.ts) };
}
const persona = (
  sender: DemoName,
  p: Omit<StoredPersona, "quotes" | "traits"> & { traits: [string, string, string, string]; quotes: string[] },
): StoredPersona => ({
  ...p,
  traits: { communication: p.traits[0], emotion: p.traits[1], humor: p.traits[2], energy: p.traits[3] },
  quotes: p.quotes.map((q) => quote(sender, q)),
});

const KEKS = (n: number) => "ㅋ".repeat(n);

export const demoReport: StoredReport = {
  safety: { flag: "none" },
  declined_topics: [],
  reading_notes: [
    { range: "03-01~04-30", note: "저녁 메뉴 질문으로 시작한 봄" },
    { range: "05-01~06-30", note: "새벽 라면 사진이 늘어난 초여름" },
    { range: "07-01~08-31", note: "큰일이 터진 밤, 내일로 미룬 얘기들" },
  ],
  headline: "저녁 메뉴로 시작해 새벽 라면으로 끝나는 방에 하는 잔소리",
  dek: "{{stat:longestStreakDays}} 내리 떠든 방이다. 다 지켜봤다. 한 사람씩 할 말이 있다.",
  chemistry: { score: 87, line: "잔소리할 게 이렇게 많은데 하루도 안 빠지고 모인다. 이 정도면 합격이다." },
  relationship: {
    one_line: "저녁마다 모이고 새벽에도 흩어지지 않는 다섯",
    to_each_other:
      "민지에게는 하루를 여는 곳, 영희에게는 웃음을 쏟는 곳, 철수에게는 새벽 사진첩, 지훈에게는 주말 기획실, 수아에게는 할 일이 정리되는 곳이다.",
    inside_jokes: ["저녁 뭐 먹을까로 시작해 결국 메뉴 미정", "새벽 두 시 라면 인증", "날짜는 누가 정해?"],
    conflict: "날짜를 정할 때마다 서로 미루다 부딪힌다. 그래도 결국 수아가 한 줄로 정리하고 끝난다.",
  },
  sections: [
    {
      part: "nag_open",
      icon: "🙄",
      title: "또 저녁 메뉴로 시작한다",
      about: "group",
      paragraphs: [
        para(
          "p1",
          '이 방의 하루는 늘 같은 질문으로 열린다. 민지가 "오늘 저녁 뭐 먹을까?" 하고 묻는 순간, 방 전체가 깨어난다. 질문은 한 글자도 안 바뀌는데 답은 매번 다르다. 다 보여. 메뉴를 정하려고 연 대화가 메뉴만 빼고 다 정하고 끝난다.',
          ["e1"],
        ),
        para(
          "p2",
          `영희는 그 질문에 웃음부터 보낸다. "${KEKS(13)} 또 시작이다". 수아는 "아무거나"라고 하고, 철수는 사진을 올리고, 지훈은 주말 얘기로 넘어간다. 메뉴는 그대로 미정이다. 이 방은 결론이 아니라 떠드는 맛으로 굴러간다.`,
          ["e2", "e3"],
        ),
        para("p3", "그래도 이 방은 하루도 그냥 넘어가지 않는다. 누군가는 꼭 먼저 말을 건다. 그건 인정. 이제 한 사람씩 잔소리 들어간다."),
      ],
      evidence: [
        evidence("e1", "민지", "오늘 저녁 뭐 먹을까?"),
        evidence("e2", "영희", `${KEKS(13)} 또 시작이다`),
        evidence("e3", "수아", "아무거나"),
      ],
    },
    {
      part: "nag_room",
      icon: "🌙",
      title: "해 지면 켜지는 방",
      about: "group",
      paragraphs: [
        para(
          "p1",
          "밤 메시지가 {{stat:nightRatio}}인 방이다. 낮에는 조용하다가 해가 지면 비로소 시작한다. 큰일이 터진 밤엔 다들 같은 말만 한다. 대박, 진짜, 어떻게. 자세한 얘기는 늘 내일로 미룬다.",
          ["e1"],
        ),
        para(
          "p2",
          '내일 하자는 얘기를 제일 많이 받아 주는 건 수아다. "ㅇㅇ 내일 점심에 말해 줄게". 이 방의 내일은 늘 수아가 지킨다. 새벽까지 왜들 안 자는 건지, 잔소리는 해도 끊지는 않겠다.',
          ["e2"],
        ),
      ],
      evidence: [
        evidence("e1", "영희", "아 그거 나도 들었어 대박이다 진짜로 어떻게 그런 일이 있지\n내일 자세히 얘기해 줘"),
        evidence("e2", "수아", "ㅇㅇ 내일 점심에 말해 줄게"),
      ],
    },
    {
      part: "nag_cards",
      icon: "📣",
      title: "민지, 판은 깔고 날짜는 안 정한다",
      about: "민지",
      paragraphs: [
        para(
          "p1",
          "이 방 메시지의 {{stat:share.민지}}가 민지 몫이다. 조용하던 방에 첫마디를 던지는 것도 민지다. 대화를 먼저 연 게 {{stat:initiations.민지}}번이다. 질문은 제일 먼저 던지는데, 대답이 오기도 전에 다음 질문이 나간다.",
        ),
        para(
          "p2",
          '약속도 민지가 꺼낸다. "좋아좋아 ' +
            KEKS(6) +
            ' 날짜는 누가 정해?" 날짜를 정하는 일만은 끝까지 남한테 넘긴다. 또 그런다. 판정 나왔다. 이 방 실세는 민지다. 민지가 조용한 날엔 방 전체가 조용하다. 그건 인정.',
          ["e1"],
        ),
      ],
      evidence: [evidence("e1", "민지", `좋아좋아 ${KEKS(6)} 날짜는 누가 정해?`)],
      mbti: "ENFP",
      mbti_reason: "판 벌이는 속도는 E, 날짜 미루는 버릇은 P. 계획표는 늘 남의 몫이다.",
      persona: persona("민지", {
        intro: "질문 먼저, 계획은 나중인 이 방의 엔진",
        traits: [
          "묻고 또 묻는다. 대답보다 다음 질문이 빠르다.",
          "좋으면 웃음부터 쏟아진다. 숨기는 게 없다.",
          "자기 말에 자기가 제일 먼저 웃는다.",
          "저녁 일곱 시에 켜져서 자정까지 안 꺼진다.",
        ],
        interests: ["저녁 메뉴", "주말 약속", "맛집", "드라마"],
        values: ["일단모이자", "재밌으면됐지", "계획은나중에"],
        quotes: ["오늘 저녁 뭐 먹을까?", "날짜는 누가 정해?", "우리 다음 달에도 이렇게 떠들자"],
        hidden: "판을 깔아 놓고 아무도 안 오면 제일 서운해할 사람이다.",
        tip: "날짜를 정해서 들이밀면 바로 좋다고 한다.",
      }),
    },
    {
      part: "nag_cards",
      icon: "🤣",
      title: "영희, 웃음소리부터 들리는 사람",
      about: "영희",
      paragraphs: [
        para(
          "p1",
          `영희의 말은 웃음으로 시작한다. ㅋ를 한 번 누르면 손이 안 멈춘다. 새벽 라면 얘기에도 "아 진짜 ${KEKS(11)} 나도 먹고 싶어". 웃는 데 쓰는 글자가 말하는 데 쓰는 글자보다 많을 때도 있다. 다 보여.`,
          ["e1"],
        ),
        para("p2", "그런데 이 웃음 덕에 방이 안 식는다. 누가 무슨 말을 해도 영희가 받아 주면 판이 커진다. 영희는 이 방의 리액션 담당, 아니 효과음 담당이다."),
      ],
      evidence: [evidence("e1", "영희", `아 진짜 ${KEKS(11)} 나도 먹고 싶어`)],
      mbti: "ESFP",
      mbti_reason: "말보다 반응이 먼저 나간다. 무대 체질, 감정 직진형이다.",
      persona: persona("영희", {
        intro: "웃음소리가 먼저 도착하는 사람",
        traits: [
          "한 줄을 보내도 반은 웃음이다.",
          "놀라면 대박, 웃기면 ㅋ를 끝없이 누른다.",
          "남의 말에 리액션을 얹어 웃음을 두 배로 키운다.",
          "새벽에도 지치지 않는다.",
        ],
        interests: ["새벽 라면", "연예 소식", "노래"],
        values: ["리액션이생명", "웃으면됐다"],
        quotes: [`${KEKS(13)} 또 시작이다`, "나도 먹고 싶어", "아 그거 나도 들었어 대박이다"],
        hidden: "웃음이 큰 만큼 남의 말을 제일 잘 듣고 있다.",
        tip: "아무 말이나 던져도 좋다. 웃어 줄 거다.",
      }),
    },
    {
      part: "nag_cards",
      icon: "📸",
      title: "철수, 새벽 라면 담당",
      about: "철수",
      paragraphs: [
        para(
          "p1",
          '철수는 말 대신 사진을 보낸다. 사진만 {{stat:media.철수.photo}}장이다. 그리고 남들이 잘 시간에 나타난다. "새벽 두 시에 라면 끓이는 사람 나야 나 ㅋ". 웃음도 ㅋ 하나로 끝낸다. 아껴 쓰는 사람이다.',
          ["e1"],
        ),
        para("p2", "답은 느긋하다. 그래도 한번 올라온 사진은 그날 대화를 다 가져간다. 철수는 이 방의 야간 특파원이다. 라면은 좀 줄이고."),
      ],
      evidence: [evidence("e1", "철수", "새벽 두 시에 라면 끓이는 사람 나야 나 ㅋ")],
      mbti: "ISTP",
      mbti_reason: "말은 짧고 사진은 많다. 혼자 조용히 할 일 다 하는 타입이다.",
      persona: persona("철수", {
        intro: "말보다 사진이 먼저인 야간 특파원",
        traits: ["짧게 말하고 사진으로 보탠다.", "ㅋ 하나에 기분이 다 들어 있다.", "새벽 라면 같은 생활 개그가 주무기다.", "남들 잘 때 깨어난다."],
        interests: ["라면", "사진", "야식"],
        values: ["말보다사진", "새벽감성"],
        quotes: ["새벽 두 시에 라면 끓이는 사람 나야 나", "사진 잘 나왔다", "배고프다"],
        hidden: "사진을 제일 많이 올리는 건 사실 대화에 끼고 싶어서다.",
        tip: "사진에 답장해 주면 말이 길어진다.",
      }),
    },
    {
      part: "nag_cards",
      icon: "🗓️",
      title: "지훈, 주말 약속 발의 담당",
      about: "지훈",
      paragraphs: [
        para(
          "p1",
          '지훈은 말수가 적은데 꼭 중요한 말을 한다. "주말에 다 같이 보자ㅋㅋㅋ". 이 한 줄로 주말 판이 열린다. 문제는 그 뒤다. 장소도 시간도 정해지기 전에 지훈은 사라진다.',
          ["e1"],
        ),
        para("p2", "그래도 지훈의 발의가 없었으면 이 방의 주말은 없었다. 판은 늘 지훈이 깐다. 이 방 공식 약속 발의 담당으로 임명한다."),
      ],
      evidence: [evidence("e1", "지훈", "주말에 다 같이 보자ㅋㅋㅋ")],
      mbti: "ENFJ",
      mbti_reason: "다 같이 보자는 말을 제일 먼저 꺼낸다. 모임을 굴리는 쪽이다.",
      persona: persona("지훈", {
        intro: "주말 약속을 발의하고 사라지는 사람",
        traits: ["할 말만 하는데 그게 꼭 약속 얘기다.", "적당히 웃고 적당히 빠진다.", "크게 웃기진 않아도 판을 깔아 준다.", "주말 앞에서 가장 높아진다."],
        interests: ["주말 모임", "여행", "맛집 예약"],
        values: ["다같이", "주말은함께"],
        quotes: ["주말에 다 같이 보자", "누가 먼저 예약할래", "주말에 뭐 해?"],
        hidden: "약속이 깨지면 가장 오래 아쉬워한다.",
        tip: "날짜는 지훈한테만 맡기지 말고 같이 정하자.",
      }),
    },
    {
      part: "nag_cards",
      icon: "⚡",
      title: "수아, 웃지 않고 제일 빨리 답한다",
      about: "수아",
      paragraphs: [
        para(
          "p1",
          '수아는 웃지 않는다. 대신 제일 빨리 답한다. 답장까지 {{stat:replyMedianMs.수아}}면 끝이다. 메뉴를 물으면 "아무거나". 짧은데 정확하다. 이 방에서 일이 굴러가게 하는 건 결국 수아다.',
          ["e1"],
        ),
        para("p2", "웃음 하나 없이 할 말만 하는데 아무도 서운해하지 않는다. 그게 수아의 기술이다. 가끔은 ㅋ 하나쯤 보내 줘도 된다."),
      ],
      evidence: [evidence("e1", "수아", "아무거나")],
      mbti: "ISTJ",
      mbti_reason: "아무거나라고 해 놓고 제일 정확하게 움직인다. 말보다 일정이 먼저다.",
      persona: persona("수아", {
        intro: "웃지 않고 일을 끝내는 사람",
        traits: ["답은 한두 단어인데 빠르다.", "표현은 적어도 할 건 다 한다.", "무표정한 한마디가 의외로 웃기다.", "필요할 때만 켜지고 그때는 가장 빠르다."],
        interests: ["점심 메뉴", "일정", "날씨"],
        values: ["짧고정확하게", "약속시간엄수"],
        quotes: ["아무거나", "내일 점심에 말해 줄게", "내가 할게"],
        hidden: "아무거나라고 하지만 사실 먹고 싶은 게 정해져 있다.",
        tip: "결론부터 말하면 가장 빨리 답이 온다.",
      }),
    },
    {
      part: "nag_last",
      icon: "✋",
      title: "마지막 한마디",
      about: "group",
      paragraphs: [
        para(
          "p1",
          "민지, 영희, 철수, 지훈, 수아. 저녁 메뉴는 이제 좀 정하고, 주말 약속은 날짜까지 박아라. 새벽 라면은 일주일에 한 번만. 그래도 하루도 안 빠지고 서로를 부르는 방은 흔하지 않다.",
          ["e1"],
        ),
        para("p2", '마지막 판정이다. "우리 다음 달에도 이렇게 떠들자" 이 말은 지켜질 거다. 잔소리는 여기까지. 다 보고 있었다.', ["e1"]),
      ],
      evidence: [evidence("e1", "민지", "우리 다음 달에도 이렇게 떠들자")],
    },
  ],
};
