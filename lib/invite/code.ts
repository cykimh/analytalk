// 초대 코드. 원문은 발급할 때 한 번만 보여 주고, DB에는 sha256 해시만 둔다.
// scripts/invite.ts(tsx, react-server 조건 없음)도 쓰므로 server-only를 붙이지 않는다. node:crypto라 브라우저 번들에는 못 들어간다.
import { createHash, randomInt } from "node:crypto";

/** 헷갈리는 0·O·1·I·L을 뺀 31자 */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const LENGTH = 10;

export function newInviteCode(): string {
  let code = "";
  for (let i = 0; i < LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

/** 입력한 코드의 앞뒤 공백을 지우고 대문자로 바꿔 sha256 hex */
export function hashCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}
