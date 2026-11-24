import { readFileSync } from "node:fs";
import path from "node:path";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect, type Page } from "@playwright/test";
import { E2E_INVITE_CODE } from "@/lib/config";

/** 테스트 모드 고정 초대 코드로 세션 쿠키를 받는다(page.request는 브라우저 컨텍스트와 쿠키를 같이 쓴다) */
export async function login(page: Page): Promise<void> {
  const res = await page.request.post("/api/invite", { data: { code: E2E_INVITE_CODE, turnstileToken: "x" } });
  expect(res.status()).toBe(200);
}

/** 진짜 Cloudflare 대신 가짜 Turnstile. 위젯 자리에 [가짜 확인] 버튼을 그리고, 누르면 토큰을 준다 */
export async function fakeTurnstile(page: Page): Promise<void> {
  await page.route("https://challenges.cloudflare.com/turnstile/**", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `window.turnstile = {
        render(el, o) {
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = "가짜 확인";
          b.onclick = () => o.callback("fake-token");
          el.append(b);
          return "w1";
        },
        reset() {},
        remove() {},
      };`,
    }),
  );
}

/** 픽스처 고유 문장. 브라우저 밖으로 나가는 요청 어디에도 실리면 안 된다 */
export const UNIQUE_SENTENCE = "테스트 고유 문장 7f3a";

const FIXTURE_DIR = path.join(__dirname, "..", "test", "fixtures");

/** 픽스처를 업로드처럼 읽는다. 맨 앞 `# …` 메타 줄은 실제 내보내기에 없으므로 뗀다(BOM은 남긴다) */
export function fixtureText(name: string): string {
  const text = readFileSync(path.join(FIXTURE_DIR, name), "utf8");
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  return bom + text.slice(bom.length).replace(/^(?:# .*\r?\n)+/, "");
}

/**
 * android-ko 픽스처 + 고유 문장 메시지 한 줄(+ 철수가 보낸 bodies). 시스템 메시지를 뺀 메시지는 11 + bodies 개다.
 * badLines만큼 머리 모양은 맞는데 해석되지 않는 줄을 넣어 인식률을 낮출 수 있다
 */
export function androidChat({ badLines = 0, bodies = [] as string[] } = {}): string {
  const bad = Array.from({ length: badLines }, (_, i) => `2024년 3월 15일 오전 9:0${i}, 망가진 줄`);
  const more = bodies.map((body, i) => `2024년 3월 15일 오전 9:${10 + i}, 철수 : ${body}`);
  return [fixtureText("android-ko.txt").trimEnd(), ...bad, `2024년 3월 15일 오전 9:02, 철수 : ${UNIQUE_SENTENCE}`, ...more, ""].join("\n");
}

export const textUpload = (name: string, text: string) => ({ name, mimeType: "text/plain", buffer: Buffer.from(text, "utf8") });

/** 폴더 안에 txt와 미디어가 든 내보내기 zip */
export async function zipUpload(name: string, entries: [path: string, text: string][]) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  for (const [entryPath, text] of entries) await writer.add(entryPath, new TextReader(text));
  return { name, mimeType: "application/zip", buffer: Buffer.from(await writer.close()) };
}

/** 페이지가 보내는 모든 요청(URL·본문)과 웹소켓 프레임을 기록한다 */
export function recordOutgoing(page: Page): string[] {
  const sent: string[] = [];
  page.on("request", (req) => {
    sent.push(req.url());
    const body = req.postDataBuffer();
    if (body) sent.push(body.toString("utf8"));
  });
  page.on("websocket", (ws) => {
    sent.push(ws.url());
    ws.on("framesent", (frame) => sent.push(typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf8")));
  });
  return sent;
}

/** 가로 스크롤이 생기지 않았는지 */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll).toBeLessThanOrEqual(client);
}
