// dev 미리보기 첫 장: 콜라주 조각 모음(종이·테이프·형광펜·스티커·폴라로이드·메모지·크레파스 막대).
// 리포트 화면은 /dev/preview/home·episode·steps·share. 링크로 들어오는 곳이 없고 프로덕션은 404다
import type { Metadata } from "next";
import { Evidence } from "@/components/episode/Evidence";
import { PageFrame } from "@/components/episode/PageState";
import { Highlight } from "@/components/scrap/Highlight";
import { Paper } from "@/components/scrap/Paper";
import { Polaroid, PolaroidStrip } from "@/components/scrap/Polaroid";
import { Sticker } from "@/components/scrap/Sticker";
import { STICKER_TONES, TAPE_COLORS, tapeAt } from "@/components/scrap/tilt";
import { BarList, CRAYON_SERIES, CRAYON_SEQUENTIAL, Columns } from "@/components/stats/charts";
import { devOnly } from "./gate";
import { PreviewNav } from "./PreviewNav";

export const metadata: Metadata = { title: "미리보기 · analytalk", robots: { index: false, follow: false } };

function Label({ children }: { children: string }) {
  return <h2 className="font-hand text-2xl font-bold">{children}</h2>;
}

export default function PreviewSheetPage() {
  devOnly();
  return (
    <>
      <PreviewNav current="sheet" />
      <PageFrame>
        <Label>종이 카드 기울기</Label>
        <Paper tilt="left" tape={tapeAt(0)} className="pt-6">
          왼쪽 −1.2° · 짧은 카드(제목·표지·차트)
        </Paper>
        <Paper tilt="right" tape={tapeAt(1)} className="pt-6">
          오른쪽 +1°
        </Paper>
        <Paper tilt="left" calm tape={tapeAt(2)} className="pt-6 text-[1.0625rem] leading-[1.8]">
          긴 본문 카드는 ±0.5° 이하(calm). 본문은 Pretendard 17px, 줄 간격 1.8. 한 문단이 길어져도 글자는 반듯하게 읽혀야 해요.
        </Paper>
        <div className="grid grid-cols-2 gap-4">
          <Paper tone="butter" tilt="right" className="text-sm">
            노란 메모지(tone butter)
          </Paper>
          <Paper tone="kraft" tilt="left" className="text-sm">
            크라프트지(tone kraft)
          </Paper>
        </div>

        <Label>마스킹 테이프</Label>
        <div className="grid grid-cols-2 gap-6 pt-2">
          {TAPE_COLORS.map((color, i) => (
            <Paper key={color} tape={{ color, at: (["center", "left", "right"] as const)[i % 3] }} className="pt-6 text-sm">
              {color}
            </Paper>
          ))}
        </div>

        <Label>형광펜</Label>
        <Paper className="grid gap-2">
          <p className="font-hand text-3xl font-bold">
            <Highlight>노랑 형광펜 #FFF3A3</Highlight>
          </p>
          <p className="font-hand text-3xl font-bold">
            <Highlight color="mint">민트 형광펜 #CDEFE3, 줄이 바뀌어도 줄마다 칠해요</Highlight>
          </p>
        </Paper>

        <Label>종이 스티커</Label>
        <div className="flex flex-wrap gap-2">
          {STICKER_TONES.map((tone, i) => (
            <Sticker key={tone} index={i} tone={tone}>
              {tone}
            </Sticker>
          ))}
          <Sticker index={6} tone="mint" aria-hidden className="px-1.5 font-sans text-lg leading-none">
            🌙
          </Sticker>
        </div>

        <Label>폴라로이드</Label>
        <PolaroidStrip>
          <Polaroid index={0} tone="butter" caption="주고받은 메시지" value="15,234" unit="개" />
          <Polaroid index={1} tone="mint" caption="함께한 날" value="412" unit="일" />
          <Polaroid index={2} tone="pink" caption="가장 뜨거웠던 날" value="388" unit="개" sub="2024-03-02" />
        </PolaroidStrip>

        <Label>근거 메모지</Label>
        <Paper calm className="grid gap-3">
          <Evidence index={0} sender="멤버01" at="2025-01-03T19:12:00+09:00" quote="오늘 저녁 뭐 먹을까?" />
          <Evidence index={1} sender="멤버02" at="2025-07-19T23:58:00+09:00" quote={"아 그거 나도 들었어 대박이다\n내일 자세히 얘기해 줘"} />
        </Paper>

        <Label>크레파스 막대</Label>
        <Paper className="grid gap-4">
          <BarList
            look="scrap"
            max={1}
            rows={CRAYON_SERIES.map((color, i) => ({ key: color, label: color, value: 1 - i * 0.11, display: `${100 - i * 11}%`, color }))}
          />
          <Columns
            look="scrap"
            label="크레파스 세로 막대 예시"
            values={[3, 5, 8, 4, 9, 12, 7, 2, 6, 10, 11, 5]}
            titles={Array.from({ length: 12 }, (_, i) => `${i + 1}`)}
            color={CRAYON_SERIES[0]}
          />
          <div className="flex gap-1">
            {CRAYON_SEQUENTIAL.map((c) => (
              <span key={c} className="size-6 rounded-[2px]" style={{ backgroundColor: c }} title={c} />
            ))}
          </div>
        </Paper>
      </PageFrame>
    </>
  );
}
