// 초대 코드 발급·폐기 (운영자가 직접 돌린다).
//
//   pnpm invite:add --label <별칭> [--limit 2] [--prod]
//   pnpm invite:revoke <코드 또는 id> [--prod]
//
// 먼저 접속할 Supabase 호스트를 찍는다. 기본은 .env.local(package.json의 --env-file),
// --prod는 .env.production.local을 직접 읽고 'prod에 쓰기: y/N'에 y를 받아야 쓴다.
// 코드는 발급할 때 한 번만 찍는다. DB에는 sha256 해시만 넣는다(다시 볼 수 없다).
// 별칭에는 실명 대신 운영자만 알아보는 이름을 쓴다.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { APP_SCHEMA } from "../lib/app";
import { DEFAULT_MONTHLY_LIMIT } from "../lib/config";
import { hashCode, newInviteCode } from "../lib/invite/code";

export type Command = { kind: "add"; label: string; limit: number; prod: boolean } | { kind: "revoke"; target: string; prod: boolean };

export function parseArgs(argv: string[]): Command {
  const [kind, ...rest] = argv;
  let prod = false;
  let label: string | undefined;
  let limit = DEFAULT_MONTHLY_LIMIT;
  const targets: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--prod") prod = true;
    else if (kind === "add" && a === "--label") label = rest[++i]?.trim();
    else if (kind === "add" && a === "--limit") {
      limit = Number(rest[++i]);
      if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit은 1 이상의 정수다");
    } else if (a.startsWith("--")) throw new Error(`알 수 없는 옵션 ${a}`);
    else targets.push(a);
  }
  if (kind === "add") {
    if (!label) throw new Error("--label <별칭>이 필요하다");
    if (targets.length) throw new Error("add는 위치 인자를 받지 않는다");
    return { kind, label, limit, prod };
  }
  if (kind === "revoke") {
    if (targets.length !== 1) throw new Error("revoke는 코드나 id 하나를 받는다");
    return { kind, target: targets[0], prod };
  }
  throw new Error("사용법: invite.ts add --label <별칭> [--limit N] [--prod] | revoke <코드 또는 id> [--prod]");
}

export const isYes = (answer: string) => /^y(es)?$/i.test(answer.trim());

export interface InviteStore {
  insert(row: { code_hash: string; label: string; monthly_limit: number }): Promise<{ id: string }>;
  /** 아직 폐기 안 된 코드를 폐기하고 바꾼 행 수를 돌려준다 */
  revoke(by: { id: string } | { codeHash: string }): Promise<number>;
}

export interface Io {
  log(line: string): void;
  confirm(question: string): Promise<boolean>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 종료 코드를 돌려준다 */
export async function runInvite(
  cmd: Command,
  env: { url?: string; key?: string },
  deps: { io: Io; open: (url: string, key: string) => InviteStore; newCode?: () => string },
): Promise<number> {
  const { url, key } = env;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL·SUPABASE_SECRET_KEY가 없다");
  deps.io.log(`접속: ${new URL(url).host}${cmd.prod ? " (prod)" : ""}`);
  if (cmd.prod && !(await deps.io.confirm("prod에 쓰기: y/N "))) {
    deps.io.log("취소했다");
    return 1;
  }
  const store = deps.open(url, key);

  if (cmd.kind === "add") {
    const code = (deps.newCode ?? newInviteCode)();
    const { id } = await store.insert({ code_hash: hashCode(code), label: cmd.label, monthly_limit: cmd.limit });
    deps.io.log(`발급: id ${id}, 월 ${cmd.limit}건, 별칭 ${cmd.label}`);
    deps.io.log(`코드: ${code}  (지금 한 번만 보인다. DB에는 해시만 있다)`);
    return 0;
  }

  const target = cmd.target.trim();
  const changed = await store.revoke(UUID.test(target) ? { id: target } : { codeHash: hashCode(target) });
  deps.io.log(changed ? "폐기했다" : "폐기할 코드가 없다(없거나 이미 폐기됨)");
  return changed ? 0 : 1;
}

function supabaseStore(url: string, key: string): InviteStore {
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }).schema(APP_SCHEMA);
  return {
    async insert(row) {
      const { data, error } = await db.from("invites").insert(row).select("id").single();
      if (error) throw new Error(`발급 실패 (${error.code})`);
      return { id: data.id };
    },
    async revoke(by) {
      const update = db.from("invites").update({ revoked_at: new Date().toISOString() }).is("revoked_at", null);
      const { data, error } = await ("id" in by ? update.eq("id", by.id) : update.eq("code_hash", by.codeHash)).select("id");
      if (error) throw new Error(`폐기 실패 (${error.code})`);
      return data.length;
    },
  };
}

async function main(): Promise<number> {
  const cmd = parseArgs(process.argv.slice(2));
  // --prod는 .env.local 값이 남아 있어도 섞이지 않게 prod 파일 값만 쓴다
  const env = cmd.prod ? parseEnv(readFileSync(".env.production.local", "utf8")) : process.env;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await runInvite(
      cmd,
      { url: env.NEXT_PUBLIC_SUPABASE_URL, key: env.SUPABASE_SECRET_KEY },
      { io: { log: (line) => console.log(line), confirm: async (q) => isYes(await rl.question(q)) }, open: supabaseStore },
    );
  } finally {
    rl.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : "초대 코드 처리 중 오류가 났다");
      process.exit(1);
    },
  );
}
