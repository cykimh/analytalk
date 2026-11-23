// 안전 신호(자해·폭력) 사전. 걸리면 화면이 페이로드를 보내지 않고 도움 안내를 띄운다. DOM 없이 브라우저·node 공용.
// "배고파 죽겠다"·"죽고 싶다" 같은 과장 표현은 친구 대화에 흔해서 넣지 않고, 행동·의도가 드러나는 표현만 둔다.
// 놓친 경우는 모델 출력의 safety 플래그가 한 번 더 막는다.
import type { ChatMessage } from "@/lib/parse/parse";

const SELF_HARM: RegExp[] = [
  /자살\s*(?:하고\s*싶|할\s*(?:거|까|래)|생각|충동|시도)/,
  /자해\s*(?:했|하고|해|를|충동)/,
  /손목\s*(?:을\s*)?(?:긋|그었|그을)/,
  /뛰어\s*내리고\s*싶/,
  /목숨\s*(?:을\s*)?끊/,
  /유서\s*(?:를\s*)?(?:썼|쓰고|써)/,
  /살고\s*싶지\s*않/,
];

const VIOLENCE: RegExp[] = [
  /칼로\s*(?:찌르|찌른|찔러|찔렀)/,
  /흉기/,
  /폭행\s*(?:당했|당해|했)/,
  /목\s*(?:을\s*)?(?:조르|졸라|졸랐)/,
  /협박\s*(?:당했|당해|했|하)/,
  /(?:가정|데이트)\s*폭력/,
  /성\s*(?:폭행|추행)/,
];

/** 발신자가 있는 메시지 중 자해 신호가 있으면 self_harm, 없고 폭력 신호가 있으면 violence */
export function safetySignal(msgs: ChatMessage[]): "self_harm" | "violence" | null {
  const texts = msgs.filter((m) => m.sender !== null && m.kind === "text").map((m) => m.text);
  if (texts.some((t) => SELF_HARM.some((re) => re.test(t)))) return "self_harm";
  if (texts.some((t) => VIOLENCE.some((re) => re.test(t)))) return "violence";
  return null;
}
