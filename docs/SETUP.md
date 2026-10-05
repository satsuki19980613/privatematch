# セットアップとデプロイ（すべて GitHub 上で）

PrivateMatch は Multiplier と同じ構成で動く。

| 区分 | 使うもの |
|---|---|
| ログイン | Neon Auth（Google） |
| データベース | Neon Postgres（部屋と進行中のゲームだけ。成績・ハンド履歴は各自の端末） |
| 読み取り | Neon Data API（RPC 関数だけを公開） |
| 書き込み（作成・参加・アクション） | Neon Function `game` |
| サイト | Cloudflare Pages（`functions/` の Pages Functions がログインの Cookie を中継） |
| デプロイ | GitHub Actions（`.github/workflows/deploy.yml`） |

`main` に push（プルリクエストのマージ）すると、テスト → Neon の準備 → マイグレーション → Function の配備 → サイトのビルドと配備が自動で走る。
設定が足りないあいだは、配備を飛ばして警告だけを出す（テストは走る）。

## 1. 一度だけやること

### Neon
1. https://console.neon.tech でプロジェクトを作る（リージョンは `AWS Asia Pacific (Singapore)` など）。
2. Project settings で **Project ID** を控える（例 `summer-hat-12345678`）。
3. Account settings → API keys で **API キー**を作る。

Neon Auth・Google ログイン・Data API・開発用ブランチ `dev` は、ワークフローが自動で用意する（`scripts/setup-neon.mjs`）。
既定のブランチ名が `production` でない場合（例 `main`）は、下の Variables に `NEON_PROD_BRANCH` を足す。

### Cloudflare
1. https://dash.cloudflare.com で Account ID を控える。
2. My Profile → API Tokens で、権限 **Cloudflare Pages: Edit** のトークンを作る。
3. サイトの URL は `https://<CF_PAGES_PROJECT>.pages.dev` になる（名前が使われていたら別の名前にする）。Pages のプロジェクトはワークフローが作る。

### GitHub（Settings → Secrets and variables → Actions）

| 種類 | 名前 | 値 |
|---|---|---|
| Secret | `NEON_API_KEY` | Neon の API キー |
| Secret | `CLOUDFLARE_API_TOKEN` | Cloudflare の API トークン |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare の Account ID |
| Variable | `NEON_PROJECT_ID` | Neon の Project ID |
| Variable | `CF_PAGES_PROJECT` | Pages のプロジェクト名（例 `privatematch`） |
| Variable | `APP_ORIGIN` | サイトの URL（例 `https://privatematch.pages.dev`。末尾の `/` なし） |
| Variable（任意） | `NEON_PROD_BRANCH` | 本番に使う Neon のブランチ名（既定 `production`） |
| Secret（任意） | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | 自前の Google OAuth クライアント（無ければ Neon の共有アプリ。同意画面に Neon の表示が出る） |

秘密の値（API キー・トークン・DB の接続文字列）はリポジトリに書かない。サイトに埋め込むのは公開の住所（Neon Auth・Data API・Function の URL）だけで、これもワークフローがその場で取得する。

## 2. デプロイ
- 自動：`main` に push する。
- 手動：Actions → **Deploy** → Run workflow → `production` か `dev`（`dev` は Neon の開発用ブランチだけを更新。サイトは配備しない）。
- 結果（各 URL）はワークフローの Summary に出る。

## 3. 開発
- 画面だけ：Codespaces などで `npm install && npm run dev` → `http://localhost:5180/?fake`（サーバー無し。Bot が相手をする）。
  - `&wait=ms` Bot の入室間隔、`&idle` Bot が動かない、`&fast` Bot の思考を短く
- 本物のサーバーにつなぐ：Deploy を `dev` で実行し、Summary の URL を `.env.development.local` に書く（`.env.example` 参照）。
- テスト：`npm test`。DB の結合テストは `TEST_DATABASE_URL` があるときだけ走る（CI では Postgres のサービスで毎回走る）。
