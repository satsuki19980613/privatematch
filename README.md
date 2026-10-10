# PrivateMatch

知り合いと気軽にポーカーの SIT & GO（No-Limit Hold'em）を遊ぶ Web アプリ。

サイト：https://privatematch.pages.dev/

- **PRIVATE MATCH** — 部屋を作ると 6 桁の部屋番号と招待 URL が出る。番号か URL で友だちが入り、人数が揃うと始まる。
- **FREE MATCH** — 公開の部屋を作る／募集中の部屋に入る。
- **STATS** — 成績（平均順位・1 位率・累計 pt・順位分布・グラフ）とハンド履歴。記録はこの端末に保存される。

部屋の設定はポーカーチェイスの SIT & GO と同じ（人数 2〜6、初期チップ 10000〜30000 枚、ブラインド構造 3 種、3 分ごとに上昇、ゲームモードの pt）。

## 個人の情報について

運営者は、遊ぶ人の個人の情報（メールアドレス・氏名・プロフィール画像・IP アドレスなど）を保存しておらず、見ることもできません。Google ログインは「前と同じ人か」を見分けるためだけに使います。

ログインのときに届く情報は、データベースに書き込まれる直前に、次のように置き換えています。

| 届く情報 | 保存されるもの |
|---|---|
| メールアドレス | `<ランダムな ID>@privatematch.invalid`（実在しない宛先） |
| Google の表示名 | `Player`（全員同じ） |
| プロフィール画像の URL | 空 |
| Google のトークン（中にメールアドレスが入っている） | 空 |
| IP アドレス・ブラウザの種類 | 空 |

サーバーに残るのは次のものだけです。

- ランダムな利用者 ID と、Google がアカウントごとに発行する番号（次のログインで同じ人だと見分けるために必要）
- 自分で付けたニックネーム
- 対局の記録とチャット（終局から 3 日で消える。成績とハンド履歴は自分の端末に保存される）

根拠：

- **仕組み** — 置き換えはデータベースのトリガーで行う。アプリやログインの仕組みがどう書き込んでも、置き換える前の値は保存されない。[20261010000000_auth_scrub.sql](db/migrations/20261010000000_auth_scrub.sql)・[20261010100000_auth_scrub_profile.sql](db/migrations/20261010100000_auth_scrub_profile.sql)
- **テスト** — 書き込みと更新のどちらでも置き換わることを、コードを変えるたびに確かめている。[test/qa-server.test.js](test/qa-server.test.js)
- **本番の確認** — 本番のデータベースに置き換える前の値が 1 件も残っていないこと、トリガーが外れていないことを、毎週とコードを変えたときに自動で数えている。残っていれば失敗になる。[scripts/auth-audit.mjs](scripts/auth-audit.mjs)・[Live の実行結果](https://github.com/satsuki19980613/privatematch/actions/workflows/live.yml)
- **アプリ** — 画面にも、ほかの人に送るデータにも、メールアドレスは出てこない。ブラウザがログインの情報から取り出すのは利用者 ID だけ。[src/net.js](src/net.js)

通信を中継する外部のサービス（Google・Cloudflare・Neon、演出 GIF を使うときは KLIPY）には、それぞれの規約のもとで接続の情報が届きます。

## 開発

- 開発：`npm install && npm run dev` → http://localhost:5180/?fake （サーバー無しで全画面を確認）
- セットアップとデプロイ（GitHub Actions → Neon + Cloudflare Pages）：[docs/SETUP.md](docs/SETUP.md)
- 設計：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
