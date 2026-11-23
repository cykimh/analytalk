// 실제 내보내기 샘플 회귀 확인(사용자가 직접 실행). 파서가 실기기 파일을 98% 이상 알아보는지 본다.
//
//   ANALYTALK_SAMPLES_DIR=~/samples pnpm check:samples
//
// 폴더 안의 .txt·.csv·.zip 파일 하나마다 한 줄을 출력한다: 순번, 형식, 인식률, 메시지 수, 기간.
// 대화 내용과 파일 이름(방 이름이 들어 있을 수 있다)은 출력하지 않는다.
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { RECOGNITION_WARN } from "../lib/config";
import { FORMAT_IDS, type FormatId } from "../lib/parse/formats";
import { parseExport } from "../lib/parse/parse";
import { readUploads } from "../lib/parse/uploads";

export interface SampleSummary {
  formatId: FormatId | null;
  recognizedRatio: number;
  messages: number;
  /** `YYYY-MM-DD ~ YYYY-MM-DD`(KST), 메시지가 없으면 `-` */
  period: string;
}

const kstDate = (ts: number) => new Date(ts + 9 * 3600_000).toISOString().slice(0, 10);

export function summarizeSample(files: { name: string; text: string }[]): SampleSummary {
  const r = parseExport(files);
  const period = r.firstTs === null || r.lastTs === null ? "-" : `${kstDate(r.firstTs)} ~ ${kstDate(r.lastTs)}`;
  return { formatId: r.formatId, recognizedRatio: r.recognizedRatio, messages: r.messages.length, period };
}

const SAMPLE_FILE = /\.(?:txt|csv|zip)$/i;

async function main(): Promise<void> {
  const dir = process.env.ANALYTALK_SAMPLES_DIR;
  if (!dir) {
    console.log("ANALYTALK_SAMPLES_DIR이 비어 있다. 실제 내보내기 파일이 든 폴더를 지정해 실행한다.");
    return;
  }
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => SAMPLE_FILE.test(n) && !n.startsWith(".")).sort();
  } catch {
    console.error("샘플 폴더를 읽을 수 없다");
    process.exit(1);
  }
  if (names.length === 0) {
    console.error("샘플 폴더에 .txt·.csv·.zip 파일이 없다");
    process.exit(1);
  }

  const confirmed = new Set<FormatId>();
  let failed = 0;
  for (const [i, name] of names.entries()) {
    const bytes = readFileSync(join(dir, name));
    const file = new File([bytes], name);
    const parts = await readUploads([file]);
    const s = summarizeSample(parts);
    const ok = s.formatId !== null && s.recognizedRatio >= RECOGNITION_WARN;
    if (ok) confirmed.add(s.formatId!);
    else failed++;
    console.log(
      `#${i + 1} ${extname(name).toLowerCase()} ${s.formatId ?? "unknown"} ${(s.recognizedRatio * 100).toFixed(1)}% ` +
        `${s.messages}건 ${s.period} ${ok ? "OK" : "미달"}`,
    );
  }
  const missing = FORMAT_IDS.filter((id) => !confirmed.has(id));
  console.log(`미확인 형식: ${missing.length === 0 ? "없음" : missing.join(", ")}`);
  if (failed > 0) {
    console.error(`인식률 ${RECOGNITION_WARN * 100}% 미달 파일 ${failed}개. 골격화해 픽스처에 추가한다`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("샘플 확인 중 오류가 났다");
    process.exit(1);
  });
}
