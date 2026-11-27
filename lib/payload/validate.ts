// 서버가 받은 페이로드를 다시 검사한다(PRD 4장: 줄 형식, 크기, 가리기 누락). DOM 없이 브라우저·node 공용.
// 오류 문구에는 본문·이름·키 값을 싣지 않는다. 응답이나 로그에 남을 수 있어서다.
import { z } from "zod";
import { MAX_PAYLOAD_BYTES } from "@/lib/config";
import { PICKABLE_TONES } from "@/lib/llm/concepts";
import type { ChatStats } from "@/lib/stats/compute";
import { memberCodes, type Payload, readBlock } from "./build";
import { maskPII } from "./mask";
import { checkDisplayName } from "./names";

const MONTH = /^\d{4}-\d{2}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_KST = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/;

const count = z.number().int().nonnegative();
const byPerson = z.record(z.string(), z.number());
const byPersonNullable = z.record(z.string(), z.number().nullable());
const metric = z.enum(["replySpeed", "questionRate", "avgLen", "count"]);

const statsSchema = z.strictObject({
  total: count,
  byPerson,
  share: byPerson,
  initiations: byPerson,
  closings: byPerson,
  replyReceivedRate: byPerson,
  replyMedianMs: byPersonNullable,
  replyP75Ms: byPersonNullable,
  monthly: z.record(
    z.string().regex(MONTH),
    z.strictObject({
      count: byPerson,
      replyMedianMs: byPersonNullable,
      replyP75Ms: byPersonNullable,
      questionRate: byPersonNullable,
      avgLen: byPersonNullable,
    }),
  ),
  hourHistogram: z.array(z.number()).length(24),
  weekdayHistogram: z.array(z.number()).length(7),
  nightRatio: z.number(),
  dailyCounts: z.record(z.string().regex(DAY), z.number()),
  longestStreakDays: z.number(),
  busiestDay: z.strictObject({ date: z.string().regex(DAY), count: z.number() }).nullable(),
  laughLength: z.record(z.string(), z.array(z.number()).length(11)),
  questionRate: byPerson,
  media: z.record(z.string(), z.strictObject({ photo: z.number(), emoticon: z.number(), link: z.number() })),
  addressTerms: z.record(z.string(), z.record(z.string(), z.number())),
  crossed: z.array(
    z.strictObject({
      month: z.string().regex(MONTH),
      person: z.string(),
      up: metric,
      down: metric,
      upPct: z.number(),
      downPct: z.number(),
    }),
  ),
}) satisfies z.ZodType<ChatStats>;

const payloadSchema = z.strictObject({
  v: z.literal(2),
  concept: z.enum(["group", "couple"]),
  kind: z.enum(["pair", "group", "work"]),
  // v2.3: 고를 수 있는 말투만 받는다. 예전 말투 record는 400(구조 오류)
  tone: z.enum(PICKABLE_TONES),
  members: z.array(z.string()).min(2),
  period: z.strictObject({ start: z.string().regex(DAY), end: z.string().regex(DAY) }),
  cutoffAt: z.string().regex(ISO_KST),
  msgTotal: count,
  msgSent: count.min(1),
  stats: statsSchema,
  anchors: z.string(),
  transcript: z.string(),
  maskCounts: z.record(z.enum(["phone", "email", "account", "rrn", "url"]), count),
}) satisfies z.ZodType<Payload>;

/** 컨셉마다 고를 수 있는 방 종류. work(직장·팀)는 아직 컨셉이 없다 */
const CONCEPT_KIND: Record<Payload["concept"], Payload["kind"]> = { couple: "pair", group: "group" };

/** stats에서 사람 이름이 들어가는 모든 자리. ChatStats에 사람 단위 맵을 더하면 여기에도 더한다 */
function statsPeople(s: ChatStats): string[] {
  const maps = [
    s.byPerson,
    s.share,
    s.initiations,
    s.closings,
    s.replyReceivedRate,
    s.replyMedianMs,
    s.replyP75Ms,
    s.laughLength,
    s.questionRate,
    s.media,
    s.addressTerms,
    ...Object.values(s.monthly).flatMap((m) => [m.count, m.replyMedianMs, m.replyP75Ms, m.questionRate, m.avgLen]),
  ];
  return [...maps.flatMap((m) => Object.keys(m)), ...s.crossed.map((c) => c.person)];
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/**
 * 크기(4MB)·구조(zod, v2·tone·members 2명 이상·me 없음)·꺾쇠 괄호·concept와 kind·members 이름·줄 형식·
 * 날짜 헤더(메시지 줄 앞에 있어야 한다)·msg_id 순서·기호(범례 안)·가리기 누락·msgSent·stats의 사람 키를 차례로 본다. msg_id는 anchors에서 transcript까지 이어서 커지기만 해야 하고,
 * transcript에는 메시지가 1개 이상 있어야 한다
 */
export function validatePayload(raw: unknown): { ok: true; payload: Payload } | { ok: false; error: string } {
  let json: string | undefined;
  try {
    json = JSON.stringify(raw);
  } catch {
    return fail("구조: JSON으로 바꿀 수 없다");
  }
  if (json === undefined) return fail("구조: 값이 없다");
  if (new TextEncoder().encode(json).length > MAX_PAYLOAD_BYTES) return fail("크기 초과");

  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // 세 번째 마디부터는 사람 이름·날짜 같은 키라서 싣지 않는다
    return fail(`구조: ${issue.path.slice(0, 2).map(String).join(".") || "(전체)"} ${issue.code}`);
  }
  const p = parsed.data;

  // 프롬프트의 <stats>·<conversation> 태그를 닫거나 열 수 없게 한다
  if (/[<>]/.test(json)) return fail("꺾쇠 괄호가 있다");
  if (CONCEPT_KIND[p.concept] !== p.kind) return fail("concept·kind 불일치");

  const members = new Set(p.members);
  if (members.size !== p.members.length || p.members.some((n) => checkDisplayName(n) !== null)) {
    return fail("members 이름 형식");
  }
  const codes = new Set(memberCodes(p.members));

  let prevId = -1;
  let sent = 0;
  for (const [name, block] of [
    ["anchors", p.anchors],
    ["transcript", p.transcript],
  ] as const) {
    const lines = readBlock(block);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const at = `${name} ${i + 1}번째 줄`;
      if (line.type === "bad") return fail(`줄 형식: ${at}`);
      if (line.type === "header") continue;
      if (line.header === null) return fail(`날짜 헤더: ${at}`);
      if (line.id <= prevId) return fail(`msg_id 순서: ${at}`);
      prevId = line.id;
      if (!codes.has(line.code)) return fail(`범례 밖의 기호: ${at}`);
      if (maskPII(line.body).text !== line.body) return fail(`가리기 누락: ${at}`);
      if (name === "transcript") sent++;
    }
  }
  if (sent !== p.msgSent) return fail("msgSent가 transcript 메시지 수와 다르다");

  if (statsPeople(p.stats).some((n) => !members.has(n))) return fail("members 밖의 stats 키");
  return { ok: true, payload: p };
}
