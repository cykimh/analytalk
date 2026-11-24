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
    ];
  },
};

export default nextConfig;
