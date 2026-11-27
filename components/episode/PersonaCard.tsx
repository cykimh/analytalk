// 페르소나 카드(v2.9): 사람 섹션 끝에 붙는 그 사람의 프로필(AI가 쓴 것, 검증을 거친 칸만). 흰 섹션 카드 안의 옅은 종이색 상자다.
// 순서: 한 줄 소개 → 성격 넷 → 관심사·해시태그 칩(한 색) → 명대사(실제 메시지, 카톡 말풍선) → 숨겨진 면모 → 대화 팁. 빈 칸은 그리지 않는다.
// 모델이 쓴 글은 StatText(React 텍스트 노드)로 그린다. 버튼은 없다(#report-capture 안)
import { ChatRoom } from "@/components/scrap/ChatBubble";
import { Sticker } from "@/components/scrap/Sticker";
import type { StoredPersona } from "@/lib/llm/schema";
import type { ChatStats } from "@/lib/stats/compute";
import { Evidence } from "./Evidence";
import { StatText } from "./StatText";

const TRAITS: [keyof StoredPersona["traits"], string][] = [
  ["communication", "말하는 방식"],
  ["emotion", "감정 표현"],
  ["humor", "유머"],
  ["energy", "대화 에너지"],
];

export function PersonaCard({ name, persona, stats }: { name: string; persona: StoredPersona; stats: ChatStats }) {
  const traits = TRAITS.filter(([key]) => persona.traits[key] !== "");
  const notes: [string, string][] = [
    ["숨겨진 면모", persona.hidden],
    ["대화 팁", persona.tip],
  ].filter((x): x is [string, string] => x[1] !== "");
  return (
    <section aria-label={`${name} 프로필`} className="grid min-w-0 grid-cols-1 gap-4 rounded-xl border border-ink/10 bg-paper/70 p-4">
      <h3 className="text-[1.125rem] leading-tight font-bold wrap-anywhere">{name} 프로필</h3>
      {persona.intro && (
        <p className="text-[1.0625rem] leading-relaxed font-bold wrap-anywhere">
          <StatText text={persona.intro} stats={stats} />
        </p>
      )}
      {traits.length > 0 && (
        <dl className="grid min-w-0 grid-cols-1 gap-2.5">
          {traits.map(([key, label]) => (
            <div key={key} className="grid min-w-0 gap-0.5">
              <dt className="text-[0.875rem] font-bold text-ink-soft">{label}</dt>
              <dd className="text-base leading-relaxed wrap-anywhere">
                <StatText text={persona.traits[key]} stats={stats} />
              </dd>
            </div>
          ))}
        </dl>
      )}
      {(persona.interests.length > 0 || persona.values.length > 0) && (
        <div className="grid min-w-0 gap-2">
          {persona.interests.length > 0 && (
            <ul role="list" aria-label="관심사" className="flex min-w-0 flex-wrap gap-1.5">
              {persona.interests.map((t) => (
                <li key={t} className="min-w-0">
                  <Sticker>{t}</Sticker>
                </li>
              ))}
            </ul>
          )}
          {persona.values.length > 0 && (
            <ul role="list" aria-label="가치관 해시태그" className="flex min-w-0 flex-wrap gap-1.5">
              {persona.values.map((t) => (
                <li key={t} className="min-w-0">
                  <Sticker>#{t}</Sticker>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {persona.quotes.length > 0 && (
        <div className="grid min-w-0 gap-2">
          <p className="text-[0.875rem] font-bold text-ink-soft">명대사</p>
          <ChatRoom>
            {persona.quotes.map((q) => (
              <Evidence key={q.msg_id} sender={q.sender} at={q.at} quote={q.quote} />
            ))}
          </ChatRoom>
        </div>
      )}
      {notes.length > 0 && (
        <dl className="grid min-w-0 grid-cols-1 gap-2.5">
          {notes.map(([label, text]) => (
            <div key={label} className="grid min-w-0 gap-0.5">
              <dt className="text-[0.875rem] font-bold text-ink-soft">{label}</dt>
              <dd className="text-base leading-relaxed wrap-anywhere">
                <StatText text={text} stats={stats} />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
