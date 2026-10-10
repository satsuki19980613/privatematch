# PrivateMatch

[![CI](https://github.com/satsuki19980613/privatematch/actions/workflows/ci.yml/badge.svg)](https://github.com/satsuki19980613/privatematch/actions/workflows/ci.yml)
[![Live](https://github.com/satsuki19980613/privatematch/actions/workflows/live.yml/badge.svg)](https://github.com/satsuki19980613/privatematch/actions/workflows/live.yml)
[![CodeQL](https://github.com/satsuki19980613/privatematch/actions/workflows/codeql.yml/badge.svg)](https://github.com/satsuki19980613/privatematch/actions/workflows/codeql.yml)

知り合いと気軽にポーカーの SIT & GO（No-Limit Hold'em）を遊ぶ Web アプリ。

サイト：https://privatematch.pages.dev/

- **PRIVATE MATCH** — 部屋を作ると 6 桁の部屋番号と招待 URL が出る。番号か URL で友だちが入り、人数が揃うと始まる。
- **FREE MATCH** — 公開の部屋を作る／募集中の部屋に入る。
- **STATS** — 成績（平均順位・1 位率・累計 pt・順位分布・グラフ）とハンド履歴。記録はこの端末に保存される。

部屋の設定はポーカーチェイスの SIT & GO と同じ（人数 2〜6、初期チップ 10000〜30000 枚、ブラインド構造 3 種、3 分ごとに上昇、ゲームモードの pt）。

## 安全とプライバシー

### ひと目で

- **運営者は、あなたのメールアドレス・氏名・プロフィール画像・IP アドレスを保存しません。** 見ることもできません。
- **ほかの人に、あなたの手札は見えません。** 山札も見えません（ショーダウンで公開された札を除く）。
- **知らない人が部屋番号を当てて入ることは、回数の制限で防いでいます。**
- **課金・広告・アクセス解析はありません。** このサイト以外のスクリプトは動かない設定です。
- **ここに書いたことは、自動の確認で確かめ続けています。** 結果は誰でも見られます（上のバッジ）。

一方で、**運営者は対局の中身（山札・全員の手札・チャット）を見ることができます。** サーバーが対局を進める仕組みのためです。運営者を信頼できる相手と遊ぶアプリです。

以下は、その詳しい中身と根拠です。

### 扱う情報の一覧

| 情報 | サーバーに保存されるもの | 運営者が見られるか | ほかの参加者に見えるか |
|---|---|---|---|
| メールアドレス | **保存しない**（実在しない宛先 `<ランダムな ID>@privatematch.invalid` に置き換える） | 見られない | 見えない |
| Google の表示名（氏名） | **保存しない**（全員 `Player` に置き換える） | 見られない | 見えない |
| プロフィール画像 | **保存しない** | 見られない | 見えない |
| IP アドレス・ブラウザの種類 | **保存しない** | 見られない | 見えない |
| Google のトークン（中にメールアドレスが入っている） | **保存しない** | 見られない | 見えない |
| Google がアカウントごとに発行する番号 | 保存する（次のログインで同じ人だと見分けるため） | 見られる | 見えない |
| ニックネーム（自分で付ける） | 保存する | 見られる | 見える |
| 対局の記録（進行中の山札・全員の手札を含む） | 保存する（終局から 3 日で消える） | 見られる | 自分の手札と、公開された札だけ |
| チャット（PRIVATE MATCH だけ） | 保存する（部屋と一緒に 3 日で消える） | 見られる | 同じ卓の人に見える |
| 選んだ演出 GIF | 保存する（部屋と一緒に 3 日で消える） | 見られる | 同じ卓の人に見える |
| 成績・ハンド履歴・プレイヤーのメモ | **保存しない**（自分の端末にだけ置く） | 見られない | 見えない |

外部のサービスに届くもの：

- **Google** — ログインするとき。
- **Cloudflare**（サイト）・**Neon**（サーバーとデータベース） — 通信を中継するので、接続の情報（IP アドレスなど）が届く。
- **KLIPY** — 演出 GIF を探す・表示するとき。検索した言葉と、端末ごとのランダムな番号が届く（ログインの ID やメールアドレスは渡さない）。
- フォントはこのサイトから配っているので、開いただけで Google に通信することはない。

### 期待できること・できないこと

期待できること：

- ほかの参加者に、山札や自分の手札を見られない。
- 部屋番号を知らない人に、PRIVATE MATCH の部屋へ入られにくい（はずれの番号は 1 人あたり 10 分に 10 回まで）。
- 運営者に、メールアドレス・氏名・画像・IP アドレスを知られない。
- 1 人が部屋を作り続けたり連打したりして、ほかの人が遊べなくなることを防ぐ（作成は 10 分に 10 回、リクエストは 1 分に 300 回まで）。

期待できないこと（限界）：

- **運営者は対局の中身を見られる。** 山札・全員の手札・チャットはサーバーのデータベースにあり、運営者は読める。
- **部屋番号か招待 URL を知っている人は、誰でも入れる。** 番号は 6 桁で、合言葉は無い。
- **回数の制限は Google アカウントごと。** アカウントを大量に用意する相手には、その分だけ弱くなる。
- **外部のサービス（Google・Cloudflare・Neon・KLIPY）がどう扱うかは、それぞれの規約による。**
- **第三者による監査は受けていない。** 個人で運営していて、確かめているのは下の自動の確認だけ。

### 仕組みと根拠

想定している相手は、手札を覗こうとするほかの参加者、部屋に入り込もうとする知らない人、個人の情報を持ちすぎてしまう運営者自身、そして Web の一般的な攻撃です。ブラウザは信用しません。ルールの判定も札を配るのもサーバーが行い、ブラウザには本人が見てよいものだけを送ります。

| 守ること | 仕組み | 根拠 |
|---|---|---|
| 個人の情報を残さない | データベースのトリガーが、書き込まれる直前に置き換える。アプリやログインの仕組みがどう書き込んでも、置き換える前の値は保存されない | [20261010000000_auth_scrub.sql](db/migrations/20261010000000_auth_scrub.sql)・[20261010100000_auth_scrub_profile.sql](db/migrations/20261010100000_auth_scrub_profile.sql)。本番に残っていないかを毎週数える [scripts/auth-audit.mjs](scripts/auth-audit.mjs) |
| 手札と山札を見せない | ほかの人の手札と山札はブラウザに送らない。データベースの表はブラウザから直接読めず、決まった関数が本人の分だけを返す | [src/engine.js](src/engine.js)（`viewFor`）・[20261005000000_init.sql](db/migrations/20261005000000_init.sql)。本物の通信で漏れが無いことを確かめる [scripts/live-check.mjs](scripts/live-check.mjs) |
| ログインした本人だけが操作できる | サーバーがリクエストごとに、ログインの署名・発行元・期限を確かめる。通信に使うトークンは、ページを開いている間だけメモリに持ち、ブラウザの保存領域には置かない | [server/game/index.js](server/game/index.js)・[src/net.js](src/net.js) |
| 部屋番号の総当たり・部屋の作りすぎ・連打を止める | 1 人ごとの回数をデータベースで数える。はずれが上限に達すると、10 分たつまで正しい番号でも入れない | [20261010200000_rate_limit.sql](db/migrations/20261010200000_rate_limit.sql)・[20261010210000_rate_req.sql](db/migrations/20261010210000_rate_req.sql) |
| ほかの人の名前やチャットで画面を乗っ取られない | 表示する前に無害化する。さらに、このサイト以外のスクリプトは動かない設定にしている | [src/ui/util.js](src/ui/util.js)（`esc`）・[public/_headers](public/_headers) |
| 札の並びを予測されない | 部屋番号・席順・山札のシャッフルに、予測できない乱数を使う | [src/rnd.js](src/rnd.js) |
| 鍵やパスワードを漏らさない | リポジトリには置かず、GitHub の Secrets に置く | [docs/SETUP.md](docs/SETUP.md) |

### 自動の確認

このページの上のバッジは、次の確認に通っていることを示します（安全を保証するものではありません）。

| 確認 | 何を確かめているか | いつ |
|---|---|---|
| [CI](https://github.com/satsuki19980613/privatematch/actions/workflows/ci.yml) | テスト（データベースを使うものを含む）とビルド | コードを変えるたび |
| [Live](https://github.com/satsuki19980613/privatematch/actions/workflows/live.yml) | 本番のサイトとサーバーに届くか、本番のデータベースに個人の情報が残っていないか。開発用の環境では、本物の通信で 1 試合と回数の制限 | 毎週と、サーバーを変えたとき |
| [CodeQL](https://github.com/satsuki19980613/privatematch/actions/workflows/codeql.yml) | GitHub 公式のコードスキャン（危ない書き方が無いか） | コードを変えるたびと毎週 |
| [Mozilla HTTP Observatory](https://developer.mozilla.org/en-US/observatory/analyze?host=privatematch.pages.dev) | 公開しているサイトの保護ヘッダ。**A+**（125 点、12 項目すべて合格。2026-10-10 に測定） | リンク先でいつでも測り直せる |

ほかに、使っている部品に弱点が見つかったら GitHub から知らせが届くようにしています（Dependabot）。

### 問題を見つけたら

[SECURITY.md](SECURITY.md) を見てください。このリポジトリの Security タブから、公開されない形で運営者に知らせることができます。

### この節の書き方について

読む人が確かめやすいよう、次の考え方に沿って書いています。

- **大事なことを先に短く、詳しいことは後ろに**（英国の個人情報保護機関 ICO の「[段階的に示す](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/the-right-to-be-informed/what-methods-can-we-use-to-provide-privacy-information/)」考え方）
- **扱う情報を決まった形の表にする**（カーネギーメロン大学の[プライバシーの「栄養成分表示」の研究](https://doi.org/10.1145/1753326.1753561)。Apple や Google のアプリストアの表示も同じ考え方）
- **期待できること・できないことを両方書き、想定する相手と対策の根拠を示す**（[OpenSSF Best Practices](https://www.bestpractices.dev/en/criteria/1) の基準）
- **知らせ方を用意し、動かしている検査を示す**（[GitHub のリポジトリのベストプラクティス](https://docs.github.com/en/repositories/creating-and-managing-repositories/best-practices-for-repositories)）

## 開発

- 開発：`npm install && npm run dev` → http://localhost:5180/?fake （サーバー無しで全画面を確認）
- セットアップとデプロイ（GitHub Actions → Neon + Cloudflare Pages）：[docs/SETUP.md](docs/SETUP.md)
- 設計：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
