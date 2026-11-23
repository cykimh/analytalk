/** 업로드 바이트 → 문자열. UTF-8(fatal)로 읽고 실패하면 euc-kr로 읽는다. 맨 앞 BOM은 지운다 */
export function decodeBytes(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("euc-kr").decode(bytes);
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
