// 리포트 출력 스키마(v2 설계 G7). 구조만 강제하고 길이·근거·구성 키는 validateReport가 저장 전에 맞춘다.
// 속성 순서가 곧 생성 순서다: safety를 앞에 둬서 응답이 끊겨도 판정이 남고, reading_notes가 먼저 와서 진행 화면에 보이고,
// 근거는 섹션 안에 둬서 끊긴 응답에서 완결된 섹션(= 앞 구성들)을 근거와 함께 살린다. 모든 속성은 required다.
// SDK 스키마 변환은 enum을 강제하지 않으므로 part는 z.enum이 아니라 z.string으로 받는다(오타 하나로 리포트 전체가 failed가 되지 않게).
// v2.8: 케미 온도(chemistry)와 사람 섹션의 MBTI 추측(mbti·mbti_reason)을 더했다. 호출끼리 output_config가 바이트 단위로 같아야
//   캐시 앞부분이 같으므로(prompt.test) 호출마다 스키마를 나누지 않는다: 모든 호출이 같은 스키마를 쓰고, 인트로만 chemistry를,
//   개인별만 사람 섹션의 mbti를 채운다(나머지는 null·빈 글). 범위(0~100)·모양(^[EI][NS][TF][JP]$)은 스키마가 아니라 validateReport가 본다
//   (스키마에 min/max·pattern을 넣으면 틀린 값 하나로 리포트 전체가 failed가 된다).
// v2.9: 개인별 응답이 사람 섹션마다 페르소나(persona)를, 마무리 응답이 관계 카드(relationship)를 쓴다(맡지 않은 응답·섹션은 null).
//   개수·글자 수·명대사 원문 확인은 validateReport가 한다
import { z } from "zod";

export const SAFETY_FLAGS = ["none", "self_harm", "violence", "minor", "abuse"] as const;
/** 금지 주제라 다루지 않은 것(system 프롬프트의 금지 넷과 같은 갈래, v2.5). 예전 행에는 inner_feelings·diagnosis 같은 v2.4 값이 있다 */
export const DECLINED_TOPICS = ["hate", "incitement", "sexual", "orientation"] as const;

const readingNote = z.object({
  range: z.string().describe("읽은 날짜 범위 MM-DD~MM-DD"),
  note: z.string().describe("60자 이하 메모"),
});

const paragraph = z.object({
  key: z.string(),
  text: z.string().describe("4~7문장, 250~400자(적어도 250자). 숫자는 {{stat:경로}}로만 쓴다"),
  evidence_ids: z.array(z.string()),
});

const evidence = z.object({
  id: z.string(),
  msg_id: z.string().describe("줄 머리의 m번호(m<번호>+<k>면 m<번호>)"),
  quote: z.string().describe("그 메시지 본문을 글자 그대로 잘라 온 부분"),
});

const section = z.object({
  part: z.string().describe("리포트 구성 키(지시의 구성 목록)"),
  icon: z.string(),
  title: z.string(),
  about: z.string().describe("pair | group | 참여자 표시 이름"),
  paragraphs: z.array(paragraph),
  evidence: z.array(evidence),
  mbti: z.string().describe("about이 참여자인 개인별 섹션만: 그 사람의 MBTI 추측 네 글자(예: ENFP). 그 밖의 섹션은 빈 글"),
  mbti_reason: z.string().describe("그 MBTI로 본 이유 한 줄(80자 이하). mbti가 빈 글이면 빈 글"),
  persona: z
    .object({
      intro: z.string().describe("한 줄 소개(80자 이하)"),
      traits: z
        .object({ communication: z.string(), emotion: z.string(), humor: z.string(), energy: z.string() })
        .describe("커뮤니케이션·감정 표현·유머·대화 에너지. 각 한두 문장(150자 이하)"),
      interests: z.array(z.string()).describe("관심 주제 3~5개(각 20자 이하)"),
      values: z.array(z.string()).describe("가치관 해시태그 3~5개(# 없이, 띄어 쓰지 않고, 각 20자 이하)"),
      quotes: z.array(evidence.omit({ id: true })).describe("명대사 3~5개: 그 사람이 보낸 메시지 하나의 본문을 글자 그대로"),
      hidden: z.string().describe("숨겨진 면모 한두 문장(150자 이하)"),
      tip: z.string().describe("이 사람과 대화할 때 팁 한 문장(100자 이하)"),
    })
    .nullable()
    .describe("about이 참여자인 개인별 섹션만. 그 밖의 섹션은 null"),
});

const chemistry = z
  .object({
    // z.number().int()는 SDK 변환이 안전 정수 범위(±9e15)를 설명 글에 덧붙여 모델에게 보인다. 정수인지는 validateReport가 본다
    score: z.number().describe("0~100 정수. 이 방(1:1이면 두 사람)의 케미 온도"),
    line: z.string().describe("그 점수에 대한 말투 인물의 한 줄 판정(80자 이하)"),
  })
  .nullable()
  .describe("인트로 응답만 쓴다. 맡지 않은 응답은 null");

const relationship = z
  .object({
    one_line: z.string().describe("관계 한 줄(80자 이하)"),
    to_each_other: z.string().describe("1:1은 서로에게 어떤 존재인지, 단톡은 이 방이 각자에게 어떤 곳인지(200자 이하)"),
    inside_jokes: z.array(z.string()).describe("내부 농담·밈 1~3개(각 80자 이하)"),
    conflict: z.string().describe("갈등 패턴과 풀리는 방식 한두 문장(200자 이하)"),
  })
  .nullable()
  .describe("마무리 응답만 쓴다. 맡지 않은 응답은 null");

export const reportSchema = z.object({
  safety: z.object({ flag: z.enum(SAFETY_FLAGS) }),
  declined_topics: z.array(z.enum(DECLINED_TOPICS)),
  reading_notes: z.array(readingNote),
  headline: z.string(),
  dek: z.string(),
  chemistry,
  relationship,
  sections: z.array(section),
});

export type Report = z.infer<typeof reportSchema>;

/**
 * 검증이 문단·근거를 지운 까닭(v2.4). 문단: empty(빈 글)·placeholder(풀리지 않는 자리표시자)·too_long·banned(금지 표현)·pii.
 * 근거: evidence_unmatched(원문과 맞지 않고 다시 이을 곳도 없음)·evidence_orphan(남은 문단이 안 씀)·evidence_over_budget(인용 몫 초과).
 * inline_quote·fake_evidence·ungrounded는 v2.4 행에만 있다(v2.5부터 그런 문단을 지우지 않는다: 따옴표만 떼거나 근거 id만 뺀다).
 * v2.8: chemistry_invalid(케미 온도 점수가 0~100 정수가 아니거나 모양이 틀려 케미 온도를 버림)·mbti_invalid(사람 섹션의 MBTI가 네 글자 모양이 아니라 버림).
 * v2.9: persona_quote_unmatched(페르소나 명대사가 그 사람의 실제 메시지와 맞지 않아 뺌). 이것들은 문단 삭제율(partial 판정)에 넣지 않는다
 */
export const DROP_REASONS = [
  "empty",
  "placeholder",
  "too_long",
  "banned",
  "pii",
  "inline_quote",
  "fake_evidence",
  "ungrounded",
  "evidence_unmatched",
  "evidence_orphan",
  "evidence_over_budget",
  "chemistry_invalid",
  "mbti_invalid",
  "persona_quote_unmatched",
] as const;
export type DropReason = (typeof DROP_REASONS)[number];
/**
 * 저장하는 검증 기록. 숫자·열거값뿐이다(대화 원문·이름 없음).
 * - relinked: m번호가 틀려 quote가 든 다른 메시지로 다시 이은 근거 수
 * - requoted(v2.5): 정규화·글자 겹침으로 맞춰 quote를 그 메시지의 원문 글자로 바꾼 근거 수
 * - unquoted(v2.5): 원문과 안 맞아 따옴표 문자만 뗀 글 안 인용 수
 * - calls(v2.5): 나눠 쓴 호출마다 결과(ok, 자기 몫 섹션이 없으면 empty, 아니면 오류 코드: max_tokens·timeout·refused·retryable·fatal·limit·invalid_output·not_started)
 * - off_stage(v2.5): 다른 호출 몫의 구성이거나 앞 호출과 같은 사람이라 뺀 섹션 수(삭제율에 넣지 않는다)
 */
export type ValidationChecks = {
  relinked: number;
  requoted: number;
  unquoted: number;
  dropped_by: Partial<Record<DropReason, number>>;
  calls?: Record<string, string>;
  off_stage?: number;
};

/** 케미 온도(v2.8). score는 0~100 정수, line은 검증을 거친 한 줄(비었을 수 있다) */
export type Chemistry = { score: number; line: string };

/** 저장하는 근거·명대사 한 줄: 페이로드에서 찾은 실제 메시지의 번호·원문 부분·보낸 사람·시각(ISO +09:00) */
export type StoredQuote = { msg_id: string; quote: string; sender: string; at: string };
/** 페르소나(v2.9). 글은 검증을 거쳤고 비었을 수 있다. 명대사는 그 사람의 실제 메시지만 */
export type StoredPersona = Omit<NonNullable<Report["sections"][number]["persona"]>, "quotes"> & { quotes: StoredQuote[] };
/** 관계 카드(v2.9) */
export type StoredRelationship = NonNullable<Report["relationship"]>;

/**
 * 저장하는 리포트. 근거에는 페이로드에서 찾은 발신자 표시 이름과 시각(ISO +09:00)을 채운다. part는 구성 키이거나 "".
 * checks는 v2.4부터 저장한다(예전 행에는 없고, v2.4 행에는 requoted·unquoted·calls가 없다).
 * v2.8: chemistry는 검증을 통과했을 때만, 사람 섹션의 mbti(대문자 네 글자)·mbti_reason도 검증을 통과했을 때만 있다(예전 행에는 없다)
 */
export type StoredReport = Omit<Report, "sections" | "chemistry" | "relationship"> & {
  checks?: ValidationChecks;
  chemistry?: Chemistry;
  /** v2.9: 검증을 거쳐 남은 것이 있을 때만 */
  relationship?: StoredRelationship;
  sections: (Omit<Report["sections"][number], "evidence" | "mbti" | "mbti_reason" | "persona"> & {
    evidence: ({ id: string } & StoredQuote)[];
    mbti?: string;
    mbti_reason?: string;
    /** v2.9: 사람 섹션에서 검증을 거쳐 남은 것이 있을 때만 */
    persona?: StoredPersona;
  })[];
};
