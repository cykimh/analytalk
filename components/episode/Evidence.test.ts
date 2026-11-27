// 근거 인용 카톡 말풍선(v2.3): 이름 → 말풍선 본문 → 시각. DOM 없이 서버 렌더 결과(HTML)로 모양과 읽는 순서를 본다
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatBubble, ChatRoom } from "@/components/scrap/ChatBubble";
import { Evidence } from "./Evidence";

const html = (sender: string, at: string, quote: string) => renderToStaticMarkup(createElement(Evidence, { sender, at, quote }));

describe("Evidence(카톡 말풍선)", () => {
  it("보낸 사람 이름(figcaption) → 말풍선 본문(blockquote.bubble) → 시각(<time>, 날짜·시각 두 줄, tabular) 순서", () => {
    const out = html("민지", "2026-10-01T20:04:00+09:00", "집에서 쉬는 중 ㅋㅋ");
    expect(out.startsWith("<figure")).toBe(true);
    const at = ["<figcaption", "민지", "<blockquote", "집에서 쉬는 중 ㅋㅋ", "<time", "2026-10-01", "20:04"].map((x) => out.indexOf(x));
    expect(at.every((x) => x >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(out).toMatch(/<figcaption[^>]*>민지<\/figcaption>/);
    expect(out).toMatch(/<blockquote class="bubble [^"]*wrap-anywhere[^"]*whitespace-pre-wrap[^"]*">집에서 쉬는 중 ㅋㅋ<\/blockquote>/);
    expect(out).toMatch(/<time datetime="2026-10-01T20:04:00\+09:00" class="[^"]*tabular-nums[^"]*">/i);
    // 글자만 이으면 "민지 … 2026-10-01 20:04"(e2e가 이 모양으로 찾는다)
    const text = out.replace(/<[^>]+>/g, "");
    expect(text).toBe("민지집에서 쉬는 중 ㅋㅋ2026-10-01 20:04");
  });

  it("포스트잇 모양(찢은 메모지·큰 따옴표·왼쪽 선)은 없다", () => {
    const out = html("민지", "2026-10-01T20:04:00+09:00", "응");
    for (const old of ["torn", "note-line", "rotate"]) expect(out).not.toContain(old);
  });

  it("인용은 텍스트 노드로만 그린다(HTML을 해석하지 않는다)", () => {
    const out = html("<b>철수</b>", "2026-10-01T20:04:00+09:00", '<img src="x" onerror="alert(1)">');
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<b>");
    expect(out).toContain("&lt;img src=&quot;x&quot;");
  });

  it("시각을 못 읽으면 <time>을 그리지 않는다", () => {
    const out = html("민지", "not-a-date", "응");
    expect(out).not.toContain("<time");
    expect(out).toContain("응");
  });

  it("ChatRoom은 말풍선을 한 판(chat-room, grid-cols-1)에 쌓는다", () => {
    const out = renderToStaticMarkup(
      createElement(
        ChatRoom,
        null,
        createElement(ChatBubble, { sender: "A", time: ["2026-10-01", "20:04"], dateTime: "x", children: "하나" }),
        createElement(ChatBubble, { sender: "B", time: ["2026-10-01", "20:05"], dateTime: "y", children: "둘" }),
      ),
    );
    expect(out).toMatch(/^<div class="chat-room grid min-w-0 grid-cols-1 /);
    expect(out.match(/<figure/g)).toHaveLength(2);
    expect(out.indexOf("하나")).toBeLessThan(out.indexOf("둘"));
  });
});
