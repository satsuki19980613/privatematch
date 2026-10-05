# PrivateMatch

知り合いと気軽にポーカーの SIT & GO（No-Limit Hold'em）を遊ぶ Web アプリ。

サイト：https://privatematch.pages.dev/

- **PRIVATE MATCH** — 部屋を作ると 6 桁の部屋番号と招待 URL が出る。番号か URL で友だちが入り、人数が揃うと始まる。
- **FREE MATCH** — 公開の部屋を作る／募集中の部屋に入る。
- **STATS** — 成績（平均順位・1 位率・累計 pt・順位分布・グラフ）とハンド履歴。記録はこの端末に保存される。

部屋の設定はポーカーチェイスの SIT & GO と同じ（人数 2〜6、初期チップ 10000〜30000 枚、ブラインド構造 3 種、3 分ごとに上昇、ゲームモードの pt）。

- 開発：`npm install && npm run dev` → http://localhost:5180/?fake （サーバー無しで全画面を確認）
- セットアップとデプロイ（GitHub Actions → Neon + Cloudflare Pages）：[docs/SETUP.md](docs/SETUP.md)
- 設計：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
