import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_ENTRY_BYTES, readUploads } from "./uploads";

async function zipFile(name: string, entries: [path: string, data: string | Uint8Array][]): Promise<File> {
  const writer = new ZipWriter(new BlobWriter("application/zip"), { useWebWorkers: false });
  for (const [path, data] of entries) {
    await writer.add(path, typeof data === "string" ? new TextReader(data) : new Uint8ArrayReader(data));
  }
  return new File([await writer.close()], name);
}

const BOM = [0xef, 0xbb, 0xbf];

describe("readUploads", () => {
  it("txt·csv는 그대로 읽는다(BOM 제거, euc-kr 대체)", async () => {
    const files = [
      new File([new Uint8Array([...BOM, ...new TextEncoder().encode("안녕")])], "KakaoTalkChats.txt"),
      new File([new Uint8Array([0xb9, 0xce, 0xc1, 0xf6])], "pc.TXT"),
      new File(['Date,User,Message\n2021-12-29 20:36:00,"민지","x"\n'], "mac.csv"),
    ];
    expect(await readUploads(files)).toEqual([
      { name: "KakaoTalkChats.txt", text: "안녕" },
      { name: "pc.TXT", text: "민지" },
      { name: "mac.csv", text: 'Date,User,Message\n2021-12-29 20:36:00,"민지","x"\n' },
    ]);
  });

  it("zip에서는 txt·csv만 꺼내고 폴더 경로는 버린다", async () => {
    const zip = await zipFile("export.zip", [
      ["KakaoTalk_Chats/Talk_2025.11.14 19:02-1.txt", "첫 파일"],
      ["KakaoTalk_Chats/photo.jpg", new Uint8Array([1, 2, 3])],
      ["__MACOSX/KakaoTalk_Chats/._Talk_2025.11.14 19:02-1.txt", new Uint8Array([0, 5, 22, 7])],
      ["KakaoTalk_Chats/Talk_2025.11.14 19:02-2.txt", "둘째 파일"],
      ["mac.csv", "Date,User,Message\n"],
    ]);
    expect(await readUploads([zip])).toEqual([
      { name: "Talk_2025.11.14 19:02-1.txt", text: "첫 파일" },
      { name: "Talk_2025.11.14 19:02-2.txt", text: "둘째 파일" },
      { name: "mac.csv", text: "Date,User,Message\n" },
    ]);
  });

  it("지원하지 않는 확장자는 건너뛴다", async () => {
    expect(await readUploads([new File(["x"], "photo.jpg")])).toEqual([]);
  });

  it("50MB를 넘는 파일은 throw", async () => {
    const big = new File([new Uint8Array(MAX_UPLOAD_ENTRY_BYTES + 1)], "big.txt");
    await expect(readUploads([big])).rejects.toThrow(/50MB/);
  });

  it("zip 안에서 50MB를 넘는 항목은 throw", async () => {
    const zip = await zipFile("big.zip", [["big.txt", new Uint8Array(MAX_UPLOAD_ENTRY_BYTES + 1)]]);
    expect(zip.size).toBeLessThan(MAX_UPLOAD_ENTRY_BYTES);
    await expect(readUploads([zip])).rejects.toThrow(/50MB/);
  });
});
