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

### FRIEND MATCH（Discord のメンバー確認。任意）
FRIEND MATCH は、専用の Discord サーバーのメンバーだけが遊べる。設定が無ければ FRIEND MATCH だけが使えず（「準備中」と出る）、ほかは今までどおり動く。
1. https://discord.com/developers/applications で **New Application** を作る（Bot は要らない）。
2. **OAuth2** を開き、**Client ID** と **Client Secret**（Reset Secret で表示）を控える。**Redirects** に、サイトの URL の末尾に `/` を付けたものを足す（例 `https://privatematch.pages.dev/`。この文字列と完全に一致している必要がある）。
3. Discord の設定 → 詳細設定 → **開発者モード** をオンにし、専用のサーバーのアイコンを右クリック → **サーバー ID をコピー**。
   サーバーの中の特定のチャンネルを見られる人だけに絞りたいときは、そのチャンネルを見られるロールを作り、サーバー設定 → ロール → 右クリック → **ロール ID をコピー**。
4. GitHub の Settings → Secrets and variables → Actions に入れる。

| 種類 | 名前 | 値 |
|---|---|---|
| Secret | `DISCORD_CLIENT_SECRET` | Client Secret |
| Variable | `DISCORD_CLIENT_ID` | Client ID |
| Variable | `DISCORD_GUILD_ID` | サーバー ID |
| Variable | `DISCORD_ROLE_ID` | ロール ID（任意。入れると、そのロールを持つ人だけ） |

5. Actions → **Deploy** → Run workflow → `production`（または `main` に push）。Function `game` に設定が渡る（`scripts/deploy-game.mjs`）。
6. 番号での確認（Discord のアプリだけで済む確認。iPhone の Discord アプリは OAuth2 の同意の画面を受け取らないので、iPhone の人はこちらを使う）を使えるようにする。
   1. 5 の配備が済んでから、Developer Portal のアプリ → **General Information** → **Interactions Endpoint URL** に、Function `game` の URL（`.env.production` の `VITE_GAME_URL`。Deploy のまとめにも出る）を入れて保存する。保存のときに Discord がこの URL を呼んで確かめる（配備の前だと保存できない）。
   2. アプリを専用のサーバーに入れる：`https://discord.com/oauth2/authorize?client_id=<Client ID>&scope=applications.commands` を開き、専用のサーバーを選んで認証する（サーバーの管理の権限が要る。Bot は入らず、`/link` コマンドだけが使えるようになる）。
   - アプリの公開鍵と `/link` コマンドの登録は、配備のときに自動で行う（`scripts/discord.mjs`。アプリ自身として Discord に入る）。配備のログに「公開鍵を読めませんでした」と出たときだけ、General Information の **Public Key** を Variable `DISCORD_PUBLIC_KEY` に入れて配備し直す。
   - Function の URL が変わったら（Neon のブランチを作り直したときなど）、Interactions Endpoint URL も入れ直す。

- 利用者に求める権限は `identify` と `guilds.members.read`（そのサーバーでの本人のメンバー情報だけ）。受け取ったトークンはその場で失効させ、保存しない。Discord の ID も保存せず、Client Secret を鍵にしたハッシュだけを残す（`server/game/discord.js`）。
  Client Secret を作り直すとハッシュが変わる。成績は Google のログインに付いているので消えないが、前の確認が切れるまで（最長 30 日）は、同じ Discord アカウントを 2 人が使っても見分けられない。
- 確認は 30 日で切れ、もう一度 Discord を経由する（許可済みなら同意の画面は出ない）。サーバーを抜けた人は、次の確認で入れなくなる。
- 番号での確認：アプリが 6 桁の番号（10 分・1 回限り）を出し、本人が専用のサーバーの中で `/link` に入れて送る。Discord が Function を呼び（署名付き）、Function は署名とサーバーを確かめて、その番号を出した人をメンバーにする。サーバーの中でコマンドを打てること自体がメンバーの証明になる。残すものは OAuth2 と同じハッシュだけ。
- 開発：`?fake` / `?demo` は確認済みとして動き、スタッツとランキングには見本（`src/friendDemo.js`）が出る。`?fake&nofriend` で確認の往復を確かめられる。開発用ブランチ `dev` には Discord の設定を渡さない（Live は「確認していない人は入れない」ことだけを確かめる）。

### 演出 GIF（KLIPY。任意）
PRIVATE MATCH の勝者の演出 GIF は KLIPY の API を使う。キーが無ければ設定に「演出 GIF」が出ず、ほかは今までどおり動く。
1. https://partner.klipy.com で登録し、**API Keys** でアプリ（Web）を作ってキーを得る。登録時の API 利用規約は保存しておく。
2. Cloudflare Pages の **Settings → Variables and Secrets** に、Production と Preview の両方へ `VITE_KLIPY_KEY` = そのキーを入れる（ビルド時に読む）。
   このキーはブラウザから KLIPY を直接呼ぶための公開の値（KLIPY の規約で、API もメディアも利用者のブラウザから直接読む決まり）。
3. 作ったばかりのキーは **Testing**（アプリ全体で 1 時間 100 回まで）。公開する前に Partner Panel から **Production** を申請する（無料・回数の上限なし）。
4. Partner Panel の **Content filtering** で、ブロックする語を必要に応じて足す（アプリ側は `content_filter=high` で呼ぶ。結果の並べ替え・間引きは規約で禁止）。
- 開発：`.env.development.local` に `VITE_KLIPY_KEY` を書く。キー無しでも `?fake` / `?demo` は手元の見本（`src/fxDemo.js`）で全部確かめられる。

秘密の値（API キー・DB の接続文字列・Discord の Client Secret）はリポジトリに書かない。コミットされるのは公開の住所（Neon Auth・Data API・Function の URL）だけ。

## 2. デプロイ
- 自動：`main` に push する。
- 手動：Actions → **Deploy** → Run workflow → `production` か `dev`（`dev` は Neon の開発用ブランチだけを更新）。
- 結果（各 URL）はワークフローの Summary に出る。

## 3. 開発
- 画面だけ：Codespaces などで `npm install && npm run dev` → `http://localhost:5180/?fake`（サーバー無し。Bot が相手をする）。
  - `&wait=ms` Bot の入室間隔、`&idle` Bot が動かない、`&fast` Bot の思考を短く
- 本物のサーバーにつなぐ：Deploy を `dev` で実行し、Summary の URL を `.env.development.local` に書く（`.env.example` 参照）。
- 本物の通信確認：Actions の **Live**（`.github/workflows/live.yml`）。本番のサイト・ログイン中継・Function・Data API に届くかを読み取りだけで確かめ、開発用ブランチ `dev` では作業ブランチのサーバーを配備してテスト用の利用者 4 人で 1 試合を打つ。作業ブランチ（`claude/**`）への push と毎週月曜に走る。`dev` のメールとパスワードの登録は、テスト用の利用者を作るこの確認の間だけ開け、終わったら閉じる（`dev` の住所は公開のログから分かるため）。認証で届く個人の情報が DB に残っていないかも、本番と `dev` で数える（`scripts/auth-audit.mjs`）。
- テスト：`npm test`。DB の結合テストは `TEST_DATABASE_URL` があるときだけ走る（CI では Postgres のサービスで毎回走る）。
