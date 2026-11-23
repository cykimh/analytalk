// 업로드 파일 읽기. .txt·.csv는 그대로, .zip은 안의 *.txt·*.csv만 꺼낸다(미디어는 버린다).
import { BlobReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";
import { decodeBytes } from "./decode";

/** 파일(또는 zip 항목) 하나의 상한 */
export const MAX_UPLOAD_ENTRY_BYTES = 50 * 1024 * 1024;

const TEXT_FILE = /\.(?:txt|csv)$/i;
const tooLarge = () => new Error("50MB를 넘는 파일은 읽지 않습니다");

export async function readUploads(files: File[]): Promise<{ name: string; text: string }[]> {
  const out: { name: string; text: string }[] = [];
  for (const file of files) {
    if (/\.zip$/i.test(file.name)) {
      out.push(...(await readZip(file)));
    } else if (TEXT_FILE.test(file.name)) {
      if (file.size > MAX_UPLOAD_ENTRY_BYTES) throw tooLarge();
      out.push({ name: file.name, text: decodeBytes(new Uint8Array(await file.arrayBuffer())) });
    }
  }
  return out;
}

async function readZip(file: File): Promise<{ name: string; text: string }[]> {
  // 파서가 이미 Web Worker 안에서 돌고, CSP가 blob 워커를 막을 수 있어 zip.js 워커는 끈다
  const reader = new ZipReader(new BlobReader(file), { useWebWorkers: false });
  const out: { name: string; text: string }[] = [];
  try {
    for (const entry of await reader.getEntries()) {
      if (entry.directory) continue;
      const path = entry.filename.split(/[\\/]/);
      const name = path[path.length - 1];
      // macOS 압축의 리소스 포크(__MACOSX/._*)는 텍스트가 아니다
      if (!TEXT_FILE.test(name) || name.startsWith("._") || path.includes("__MACOSX")) continue;
      if (entry.uncompressedSize > MAX_UPLOAD_ENTRY_BYTES) throw tooLarge();
      const bytes = await entry.getData(new Uint8ArrayWriter());
      if (bytes.length > MAX_UPLOAD_ENTRY_BYTES) throw tooLarge();
      out.push({ name, text: decodeBytes(bytes) });
    }
  } finally {
    await reader.close();
  }
  return out;
}
