# PrivateMatch

[![CI](https://github.com/satsuki19980613/privatematch/actions/workflows/ci.yml/badge.svg)](https://github.com/satsuki19980613/privatematch/actions/workflows/ci.yml)
[![Live](https://github.com/satsuki19980613/privatematch/actions/workflows/live.yml/badge.svg)](https://github.com/satsuki19980613/privatematch/actions/workflows/live.yml)
[![CodeQL](https://github.com/satsuki19980613/privatematch/actions/workflows/codeql.yml/badge.svg)](https://github.com/satsuki19980613/privatematch/actions/workflows/codeql.yml)
[![Secrets](https://github.com/satsuki19980613/privatematch/actions/workflows/secrets.yml/badge.svg)](https://github.com/satsuki19980613/privatematch/actions/workflows/secrets.yml)

知人同士で No-Limit Hold'em の SIT & GO を遊ぶ Web アプリ。

部屋の設定はポーカーチェイスの SIT & GO と同じである（人数 2〜6、初期チップ 10000〜30000 枚、ブラインド構造 3 種、3 分ごとに上昇、ゲームモードごとの pt）。

**公開サイト**：https://privatematch.pages.dev/

## 機能

- **PRIVATE MATCH** — 部屋を作成すると、6 桁の部屋番号と招待 URL が発行される。番号か URL で参加し、人数がそろうと開始する。
- **FREE MATCH** — 公開の部屋の作成と、募集中の部屋への参加。
- **FRIEND MATCH** — 専用の Discord サーバーのメンバーだけが参加できる部屋。メンバー全員のスタッツ（合計 pt・平均 pt・加点率・1 位率・平均順位・生存ターン。シーズン内とシーズン推移）とランキングを、ゲームモードごとに表示する。
- **STATS** — 成績（平均順位・1 位率・累計 pt・順位分布・グラフ）とハンド履歴。記録は端末に保存する。

## セキュリティとプライバシー

### 要約

- **メールアドレス・氏名・プロフィール画像・IP アドレスを保存しない。** 運営者も閲覧できない。
- **Discord の ID・名前・トークンを保存しない。** FRIEND MATCH の確認で保存するのは、照合用のハッシュと確認の日時だけである。
- **他の参加者には、自分の手札と山札が見えない**（ショーダウンで公開された札を除く）。
- **部屋番号の総当たりによる第三者の侵入は、レート制限で防いでいる。**
- **課金・広告・アクセス解析は無い。** 自サイト以外のスクリプトは実行されない設定である。
- **以上の内容は自動検証で継続的に確認している。** 結果は上部のバッジで公開している。

**制約**：運営者は対局の内容（山札・全員の手札・チャット）を閲覧できる。サーバーが対局を進行させる設計のためである。運営者を信頼できる利用者に向けたアプリである。

### 取り扱う情報

| 情報 | サーバーへの保存 | 運営者による閲覧 | 他の参加者への表示 |
|---|---|---|---|
| メールアドレス | **保存しない**（実在しない宛先 `<ランダムな ID>@privatematch.invalid` に置換） | 不可 | 不可 |
| Google の表示名（氏名） | **保存しない**（全員 `Player` に置換） | 不可 | 不可 |
| プロフィール画像 | **保存しない** | 不可 | 不可 |
| IP アドレス・ブラウザの種類 | **保存しない** | 不可 | 不可 |
| Google のトークン（メールアドレスを含む） | **保存しない** | 不可 | 不可 |
| Google のアカウント識別子 | 保存（再ログイン時の本人識別のため） | 可 | 不可 |
| ニックネーム（任意に設定） | 保存 | 可 | 可 |
| 対局記録（進行中の山札・全員の手札を含む） | 保存（終局から 3 日で削除） | 可 | 自分の手札と公開済みの札のみ |
| チャット（PRIVATE MATCH・FRIEND MATCH） | 保存（部屋とともに 3 日で削除） | 可 | 同じ卓の参加者 |
| 選択した演出 GIF | 保存（部屋とともに 3 日で削除） | 可 | 同じ卓の参加者 |
| 成績・ハンド履歴・プレイヤーのメモ | **保存しない**（端末内のみ） | 不可 | 不可 |
| Discord の利用者 ID・名前・トークン（FRIEND MATCH の確認） | **保存しない**（トークンは確認の直後に失効させる） | 不可 | 不可 |
| 番号での確認のために出した番号（6 桁） | 保存（最長 10 分。使うと消える） | 可 | 不可 |
| Discord の利用者 ID の照合用ハッシュ・確認の日時 | 保存（確認は 30 日で失効。同じ Discord アカウントの重複を防ぐため） | 可（ハッシュから ID は復元できない） | 不可 |
| FRIEND MATCH の結果（ゲームモード・順位・pt・ハンド数・VPIP と PFR の回数・日時） | 保存（期限なし） | 可 | FRIEND MATCH のメンバー（ニックネームとともに） |

外部サービスに送信される情報：

- **Google** — ログイン時。
- **Discord** — FRIEND MATCH の確認時のみ。利用者が Discord の画面で許可すると、サーバーが Discord に、専用のサーバーでのメンバー情報を問い合わせる。番号での確認では、利用者が専用のサーバーの中で `/link` コマンドを送ると、Discord がサーバーにその利用者の ID とサーバーの ID を知らせる（ID は保存しない）。対局の内容や成績は送信しない。
- **Cloudflare**（サイト配信）・**Neon**（サーバー・データベース） — 通信を中継するため、接続情報（IP アドレスなど）が送信される。
- **KLIPY** — 演出 GIF の検索・表示時。検索語と端末ごとのランダムな識別子が送信される（ログイン ID やメールアドレスは送信しない）。
- フォントは自サイトから配信しており、ページを開くだけで Google に通信することはない。

### 保証範囲と制約

保証する事項：

- 他の参加者に、山札や自分の手札を見られない。
- 部屋番号を知らない第三者は、PRIVATE MATCH の部屋に入りにくい（不正な番号の入力は 1 人あたり 10 分間に 10 回まで）。
- FRIEND MATCH の部屋とスタッツには、専用の Discord サーバーのメンバーと確認できた利用者しか入れない（部屋番号を知っていても入れない）。
- メールアドレス・氏名・画像・IP アドレスを運営者に知られない。
- 1 人による部屋の大量作成や連打で、他の利用者が遊べなくなることを防ぐ（作成は 10 分間に 10 回、リクエストは 1 分間に 300 回まで）。

制約：

- **運営者は対局の内容を閲覧できる。** 山札・全員の手札・チャットはサーバーのデータベースに保存される。
- **PRIVATE MATCH は、部屋番号か招待 URL を知っていれば誰でも参加できる。** 番号は 6 桁で、パスワードは無い。
- **FRIEND MATCH の結果は、メンバー全員に表示される。** ニックネームごとの成績がランキングとスタッツに表示され、期限なく保存される。
- **Discord のサーバーを脱退しても、最長 30 日は FRIEND MATCH に入れる。** メンバーの確認は 30 日ごとに行うためである。
- **レート制限は Google アカウント単位である。** アカウントを大量に用意する攻撃者に対しては、その分だけ効果が下がる。
- **外部サービス（Google・Cloudflare・Neon・KLIPY・Discord）における取り扱いは、各社の規約に従う。**
- **第三者による監査は受けていない。** 個人による運営であり、検証は下記の自動検証に限られる。

### 脅威モデルと対策

想定する脅威は、手札の覗き見を試みる参加者、部屋への侵入を試みる第三者、個人情報を過剰に保持してしまう運営者自身、および一般的な Web 攻撃である。ブラウザは信頼しない。ルールの判定と配札はサーバーが行い、ブラウザには本人が閲覧してよい情報だけを送る。

| 対策目標 | 実装 | 根拠 |
|---|---|---|
| 個人情報を保持しない | データベースのトリガーが、書き込みの直前に値を置換する。アプリや認証基盤がどの経路で書き込んでも、置換前の値は保存されない | [20261010000000_auth_scrub.sql](db/migrations/20261010000000_auth_scrub.sql)・[20261010100000_auth_scrub_profile.sql](db/migrations/20261010100000_auth_scrub_profile.sql)。本番の残存を毎週検査する [scripts/auth-audit.mjs](scripts/auth-audit.mjs) |
| 手札と山札の秘匿 | 他人の手札と山札はブラウザに送らない。テーブルはブラウザから直接読めず、所定の関数が本人の分だけを返す | [src/engine.js](src/engine.js)（`viewFor`）・[20261005000000_init.sql](db/migrations/20261005000000_init.sql)。実際の通信で漏洩が無いことを検証する [scripts/live-check.mjs](scripts/live-check.mjs) |
| 本人以外による操作の防止 | サーバーがリクエストごとに、トークンの署名・発行者・有効期限を検証する。トークンはページ表示中のみメモリに保持し、ブラウザのストレージには保存しない | [server/game/index.js](server/game/index.js)・[src/net.js](src/net.js) |
| FRIEND MATCH をメンバーに限定する | Discord の OAuth2 で、専用のサーバーでの本人のメンバー情報だけを読む。確認はサーバー側で行い、部屋の作成・参加・スタッツの取得のたびに有効期限を検査する。Discord の ID は保存せず、秘密の鍵によるハッシュ（HMAC-SHA256）だけを保存する | [server/game/discord.js](server/game/discord.js)・[20261012000000_friend.sql](db/migrations/20261012000000_friend.sql) |
| 総当たり・部屋の大量作成・連打の防止 | ユーザーごとの回数をデータベースで計数する。不正な番号の入力が上限に達すると、10 分経過するまで正しい番号でも参加できない | [20261010200000_rate_limit.sql](db/migrations/20261010200000_rate_limit.sql)・[20261010210000_rate_req.sql](db/migrations/20261010210000_rate_req.sql) |
| XSS の防止 | ニックネームやチャットは表示前にエスケープする。加えて、自サイト以外のスクリプトを実行させない | [src/ui/util.js](src/ui/util.js)（`esc`）・[public/_headers](public/_headers) |
| 配札の予測防止 | 部屋番号・席順・山札のシャッフルに暗号論的乱数を使う | [src/rnd.js](src/rnd.js) |
| 秘密情報の管理 | リポジトリには置かず、GitHub の Secrets で管理する | [docs/SETUP.md](docs/SETUP.md) |

### 自動検証

上部のバッジは、次の検証の結果を示す（安全性を保証するものではない）。

| 検証 | 内容 | 実行タイミング |
|---|---|---|
| [CI](https://github.com/satsuki19980613/privatematch/actions/workflows/ci.yml) | テスト（データベースを使うものを含む）とビルド | コード変更時 |
| [Live](https://github.com/satsuki19980613/privatematch/actions/workflows/live.yml) | 本番のサイトとサーバーの疎通、本番のデータベースに個人情報が残っていないこと。開発環境では、実際の通信による 1 試合とレート制限 | 毎週・サーバー変更時 |
| [CodeQL](https://github.com/satsuki19980613/privatematch/actions/workflows/codeql.yml) | GitHub CodeQL による静的解析 | コード変更時・毎週 |
| [Secrets](https://github.com/satsuki19980613/privatematch/actions/workflows/secrets.yml) | gitleaks による秘密情報（API キー・トークン・パスワード・秘密鍵など）の検査。全ブランチの全履歴が対象 | コード変更時・毎週 |
| [Mozilla HTTP Observatory](https://developer.mozilla.org/en-US/observatory/analyze?host=privatematch.pages.dev) | 公開サイトのセキュリティヘッダー。**A+**（125 点、12 項目すべて合格。2026-10-10 測定） | リンク先で随時再測定できる |

このほか、依存パッケージの脆弱性を Dependabot で通知している。

### 脆弱性の報告

[SECURITY.md](SECURITY.md) を参照。リポジトリの Security タブから非公開で報告できる。

### 記載方針

本節は次の指針に基づいて構成している。

- 要点を先に、詳細を後に示す（英国 ICO の[段階的な情報提供](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/the-right-to-be-informed/what-methods-can-we-use-to-provide-privacy-information/)）
- 取り扱う情報を定型の表で示す（カーネギーメロン大学の[プライバシーの「栄養成分表示」の研究](https://doi.org/10.1145/1753326.1753561)。Apple・Google のアプリストアの表示も同じ考え方）
- 保証範囲と制約、想定する脅威と対策の根拠を示す（[OpenSSF Best Practices](https://www.bestpractices.dev/en/criteria/1)）
- 報告窓口と実施中の検証を示す（[GitHub のリポジトリのベストプラクティス](https://docs.github.com/en/repositories/creating-and-managing-repositories/best-practices-for-repositories)）

## 開発

### 必要環境

- Node.js 22.12 以上

### コマンド

| コマンド | 内容 |
|---|---|
| `npm install` | 依存パッケージのインストール |
| `npm run dev` | 開発サーバー（http://localhost:5180/）。`?fake` でサーバー無しに全画面を確認できる |
| `npm test` | 単体テスト（`TEST_DATABASE_URL` を設定するとデータベースの結合テストも実行） |
| `npm run build` | 本番ビルド |

### 関連資料

- セットアップとデプロイ（GitHub Actions → Neon + Cloudflare Pages）：[docs/SETUP.md](docs/SETUP.md)
- 設計：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
