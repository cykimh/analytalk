import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // 공유 화면: 검색에 남기지 않고, 토큰이 든 주소를 Referer로 흘리지 않는다
        source: "/s/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
      {
        // 데모 리포트(v2.8): 초대 코드 없이 열리지만 검색에는 남기지 않는다(페이지 메타 robots와 같이)
        source: "/demo",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
    ];
  },
};

export default nextConfig;
