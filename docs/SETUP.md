# セットアップとデプロイ（すべて GitHub 上で）

PrivateMatch は Multiplier と同じ構成で動く。

| 区分 | 使うもの |
|---|---|
| ログイン | Neon Auth（Google） |
| データベース | Neon Postgres（部屋と進行中のゲームだけ。成績・ハンド履歴は各自の端末） |
| 読み取り | Neon Data API（RPC 関数だけを公開） |
| 書き込み（作成・参加・アクション） | Neon Function `game` |
| サイト | Cloudflare Pages（`functions/` の Pages Functions がログインの Cookie を中継） |
| デプロイ | GitHub Actions（`.github/workflows/deploy.yml`）がサーバー側を、Cloudflare Pages の GitHub 連携がサイトを配備 |

`main` に push すると、テスト → Neon の準備 → マイグレーション → Function の配備 → 本番の公開の住所（`.env.production` と `src/prodConfig.js`）を `main` にコミット、まで自動で走る。
Cloudflare Pages は GitHub 連携で `main` を見ていて、そのコミットでサイトを作り直す。API キーやトークンを手で写す作業は無い。

## 1. 一度だけやること（クリックだけ）

### Neon
1. https://console.neon.tech でプロジェクトを作る（リージョンは `AWS Asia Pacific (Singapore)` など）。
2. そのプロジェクトの **Integrations → GitHub** で GitHub とつなぎ、リポジトリ `privatematch` を選ぶ。
   リポジトリに Secret `NEON_API_KEY` と Variable `NEON_PROJECT_ID` が入る（Settings → Secrets and variables → Actions で確認できる）。

Neon Auth・Google ログイン・Data API・開発用ブランチ `dev` は、ワークフローが自動で用意する（`scripts/setup-neon.mjs`）。本番はメールとパスワードの登録と localhost を止めて Google だけにする。

### Cloudflare Pages
1. https://dash.cloudflare.com → **Workers & Pages → Create → Pages → Connect to Git** で `privatematch` を選ぶ。
2. ビルドの設定：Framework preset なし、Build command `npm run build`、Build output directory `dist`、Production branch `main`。
3. プロジェクト名は `privatematch` のままにする（サイトは `https://privatematch.pages.dev`）。別の名前にしたときは、GitHub の Variable `CF_PAGES_PROJECT` にその名前を入れる（独自ドメインなら `APP_ORIGIN` に URL）。

### 任意の設定（GitHub の Settings → Secrets and variables → Actions）

| 種類 | 名前 | 値 |
|---|---|---|
| Variable | `CF_PAGES_PROJECT` | Pages のプロジェクト名（既定 `privatematch`） |
| Variable | `APP_ORIGIN` | サイトの URL（既定 `https://<CF_PAGES_PROJECT>.pages.dev`） |
| Variable | `NEON_PROD_BRANCH` | 本番に使う Neon のブランチ名（既定 `production`。その名前が無ければプロジェクトの既定のブランチを使う） |
| Secret | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | 自前の Google OAuth クライアント（無ければ Neon の共有アプリ。同意画面に Neon の表示が出る） |

秘密の値（API キー・DB の接続文字列）はリポジトリに書かない。コミットされるのは公開の住所（Neon Auth・Data API・Function の URL）だけ。

## 2. デプロイ
- 自動：`main` に push する。
- 手動：Actions → **Deploy** → Run workflow → `production` か `dev`（`dev` は Neon の開発用ブランチだけを更新）。
- 結果（各 URL）はワークフローの Summary に出る。

## 3. 開発
- 画面だけ：Codespaces などで `npm install && npm run dev` → `http://localhost:5180/?fake`（サーバー無し。Bot が相手をする）。
  - `&wait=ms` Bot の入室間隔、`&idle` Bot が動かない、`&fast` Bot の思考を短く
- 本物のサーバーにつなぐ：Deploy を `dev` で実行し、Summary の URL を `.env.development.local` に書く（`.env.example` 参照）。
- 本物の通信確認：Actions の **Live**（`.github/workflows/live.yml`）。本番のサイト・ログイン中継・Function・Data API に届くかを読み取りだけで確かめ、開発用ブランチ `dev` では作業ブランチのサーバーを配備してテスト用の利用者 4 人で 1 試合を打つ。作業ブランチ（`claude/**`）への push と毎週月曜に走る。
- テスト：`npm test`。DB の結合テストは `TEST_DATABASE_URL` があるときだけ走る（CI では Postgres のサービスで毎回走る）。
