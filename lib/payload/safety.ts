// 안전 신호(자해·폭력) 사전. 보낼 메시지에서 걸리면 화면이 페이로드를 보내지 않고 도움 안내를 띄운다. DOM 없이 브라우저·node 공용.
// "배고파 죽겠다"·"죽고 싶다" 같은 과장 표현은 친구 대화에 흔해서 넣지 않고, 행동·의도가 드러나는 표현만 둔다.
// 놓친 경우는 모델 출력의 safety 플래그가 한 번 더 막는다.
import type { ChatMessage } from "@/lib/parse/parse";
import { type Payload, payloadIndex } from "./build";

// 한글 낱말 속(과목·발목·제목 "졸라", 사유서·시말서)에 걸리지 않게 앞에 한글이 없을 때만 본다
const NOT_AFTER_HANGUL = "(?<![가-힣])";

const SELF_HARM: RegExp[] = [
  /자살\s*(?:하고\s*싶|할\s*(?:거|까|래)|생각|충동|시도)/,
  /자해\s*(?:했|하고|해|를|충동)/,
  /손목\s*(?:을\s*)?(?:긋|그었|그을)/,
  /뛰어\s*내리고\s*싶/,
  /목숨\s*(?:을\s*)?끊/,
  new RegExp(`${NOT_AFTER_HANGUL}유서\\s*(?:를\\s*)?(?:썼|쓰고|써)`),
  // "거기선 살고 싶지 않아"처럼 곳·조건을 말하는 것은 빼고, 삶 자체를 말하는 꼴만 본다
  /(?:더\s*(?:이상\s*)?|그만\s*)살고\s*싶지\s*않/,
];

// 뉴스·영화 이야기("흉기 난동", "성추행 뉴스", "폭행했대")와 농담("협박하냐 ㅋㅋ")은 흔하다.
// 위협·피해를 겪은 쪽의 말(당했다·위협받았다·목을 졸랐다)만 본다
const VIOLENCE: RegExp[] = [
  /칼로\s*(?:찌른다|찌를\s*거|찔러\s*버|찔렀)/,
  /흉기\s*(?:로|를)\s*(?:위협|협박|들이대|들이밀)/,
  /폭행\s*(?:을\s*)?(?:당했|당해|당하)/,
  new RegExp(`${NOT_AFTER_HANGUL}목\\s*(?:을\\s*)?(?:조르|졸랐|졸려서|졸렸)`),
  /협박\s*(?:을\s*)?(?:당했|당해|당하|받았|받고)/,
  /(?:가정|데이트)\s*폭력/,
  /성\s*(?:폭행|추행)\s*(?:을\s*)?(?:당했|당해|당하)/,
];

/** 발신자가 있는 메시지 중 자해 신호가 있으면 self_harm, 없고 폭력 신호가 있으면 violence */
export function safetySignal(msgs: ChatMessage[]): "self_harm" | "violence" | null {
  const texts = msgs.filter((m) => m.sender !== null && m.kind === "text").map((m) => m.text);
  if (texts.some((t) => SELF_HARM.some((re) => re.test(t)))) return "self_harm";
  if (texts.some((t) => VIOLENCE.some((re) => re.test(t)))) return "violence";
  return null;
}

/**
 * 페이로드에 실리는 메시지(anchors + transcript)만 본다. 보내지 않는 몇 년 전 메시지 때문에 AI 연재를 막지 않는다.
 * 본문은 가리기 전 것(messages)으로 본다: [가림:민감]으로 바뀐 본문 속 신호도 놓치지 않는다
 */
export function sentSafetySignal(p: Payload, msgs: ChatMessage[]): "self_harm" | "violence" | null {
  const sent = payloadIndex(p);
  return safetySignal(msgs.filter((m) => sent.has(`m${m.id}`)));
}
