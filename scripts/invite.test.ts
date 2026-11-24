import { describe, expect, it, vi } from "vitest";
import { hashCode } from "../lib/invite/code";
import { isYes, parseArgs, runInvite, type InviteStore } from "./invite";

const ENV = { url: "http://127.0.0.1:54321", key: "sb_secret_test" };
const ID = "0b6c3f1e-2a4d-4c5b-9e8f-7a6b5c4d3e2f";

function fakeIo(answer: boolean) {
  const lines: string[] = [];
  const asked: string[] = [];
  return {
    lines,
    asked,
    io: {
      log: (line: string) => void lines.push(line),
      confirm: async (question: string) => {
        asked.push(question);
        return answer;
      },
    },
  };
}

function fakeStore(revokedCount = 1) {
  const store: InviteStore = {
    insert: vi.fn(async () => ({ id: ID })),
    revoke: vi.fn(async () => revokedCount),
  };
  const open = vi.fn(() => store);
  return { store, open };
}

describe("parseArgs", () => {
  it("add: 별칭, 월 한도(기본 2), --prod", () => {
    expect(parseArgs(["add", "--label", "친구A"])).toEqual({ kind: "add", label: "친구A", limit: 2, prod: false });
    expect(parseArgs(["add", "--label", "친구A", "--limit", "3", "--prod"])).toEqual({ kind: "add", label: "친구A", limit: 3, prod: true });
  });

  it("revoke: 코드나 id 하나", () => {
    expect(parseArgs(["revoke", "ABCD234567", "--prod"])).toEqual({ kind: "revoke", target: "ABCD234567", prod: true });
  });

  it.each([
    [[]],
    [["add"]],
    [["add", "--label"]],
    [["add", "--label", " "]],
    [["add", "--label", "a", "--limit", "0"]],
    [["add", "--label", "a", "--limit", "x"]],
    [["add", "--label", "a", "--bogus"]],
    [["revoke"]],
    [["revoke", "a", "b"]],
    [["list"]],
  ])("잘못된 인자 %j 는 던진다", (argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });
});

describe("isYes", () => {
  it.each([
    ["y", true],
    ["Y", true],
    [" yes ", true],
    ["", false],
    ["n", false],
    ["yy", false],
  ])("%j → %s", (answer, yes) => {
    expect(isYes(answer)).toBe(yes);
  });
});

describe("runInvite", () => {
  it("먼저 접속 호스트를 찍는다", async () => {
    const { lines, io } = fakeIo(true);
    const { open } = fakeStore();
    await runInvite(parseArgs(["add", "--label", "친구A"]), ENV, { io, open, newCode: () => "ABCD234567" });
    expect(lines[0]).toContain("127.0.0.1:54321");
  });

  it("add: 코드는 한 번만 찍고, DB에는 해시만 넣는다", async () => {
    const { lines, io } = fakeIo(true);
    const { store, open } = fakeStore();
    const exit = await runInvite(parseArgs(["add", "--label", "친구A", "--limit", "3"]), ENV, { io, open, newCode: () => "ABCD234567" });
    expect(exit).toBe(0);
    expect(open).toHaveBeenCalledWith(ENV.url, ENV.key);
    expect(store.insert).toHaveBeenCalledWith({ code_hash: hashCode("ABCD234567"), label: "친구A", monthly_limit: 3 });
    expect(JSON.stringify(vi.mocked(store.insert).mock.calls)).not.toContain("ABCD234567");
    expect(lines.filter((l) => l.includes("ABCD234567"))).toHaveLength(1);
    expect(lines.some((l) => l.includes(ID))).toBe(true);
  });

  it("--prod는 'prod에 쓰기: y/N'에 y를 받아야 DB를 연다", async () => {
    const declined = fakeIo(false);
    const a = fakeStore();
    expect(await runInvite(parseArgs(["add", "--label", "친구A", "--prod"]), ENV, { io: declined.io, open: a.open })).toBe(1);
    expect(declined.asked).toEqual(["prod에 쓰기: y/N "]);
    expect(a.open).not.toHaveBeenCalled();

    const accepted = fakeIo(true);
    const b = fakeStore();
    expect(await runInvite(parseArgs(["add", "--label", "친구A", "--prod"]), ENV, { io: accepted.io, open: b.open })).toBe(0);
    expect(b.store.insert).toHaveBeenCalledTimes(1);
  });

  it("--prod가 아니면 묻지 않는다", async () => {
    const { asked, io } = fakeIo(false);
    const { store, open } = fakeStore();
    await runInvite(parseArgs(["add", "--label", "친구A"]), ENV, { io, open });
    expect(asked).toEqual([]);
    expect(store.insert).toHaveBeenCalledTimes(1);
  });

  it("revoke: uuid면 id로, 아니면 코드 해시로 폐기한다", async () => {
    const { io } = fakeIo(true);
    const { store, open } = fakeStore();
    expect(await runInvite(parseArgs(["revoke", ID]), ENV, { io, open })).toBe(0);
    expect(await runInvite(parseArgs(["revoke", " abcd234567 "]), ENV, { io, open })).toBe(0);
    expect(vi.mocked(store.revoke).mock.calls).toEqual([[{ id: ID }], [{ codeHash: hashCode("ABCD234567") }]]);
  });

  it("revoke 대상이 없으면(이미 폐기 포함) 1로 끝낸다", async () => {
    const { io } = fakeIo(true);
    const { open } = fakeStore(0);
    expect(await runInvite(parseArgs(["revoke", "ABCD234567"]), ENV, { io, open })).toBe(1);
  });

  it("URL이나 secret 키가 없으면 던진다", async () => {
    const { io } = fakeIo(true);
    const { open } = fakeStore();
    await expect(runInvite(parseArgs(["revoke", "ABCD234567"]), { url: ENV.url }, { io, open })).rejects.toThrow();
    await expect(runInvite(parseArgs(["revoke", "ABCD234567"]), { key: ENV.key }, { io, open })).rejects.toThrow();
  });
});
