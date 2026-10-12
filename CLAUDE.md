# CLAUDE.md — PrivateMatch

このリポジトリで作業するセッションが最初に読む文書。

## 1. 概要
- **アプリ**: PrivateMatch。知り合いと気軽にポーカー（NLHE）の SIT & GO を遊ぶ。完全無料・課金なし。
- **メニュー**: PRIVATE MATCH（部屋を作る → 部屋番号と招待 URL が出る / 部屋番号で入る）、FREE MATCH（公開の部屋を作る＋募集中の一覧）、FRIEND MATCH（専用の Discord サーバーのメンバーだけ）、STATS（成績とハンド履歴）。Google ログイン必須。
- **FRIEND MATCH**: メニューのボタンは、専用の Discord サーバーのメンバーだと確認できた人だけが先へ進める（Discord の OAuth2。確認は 30 日ごと。サーバーも部屋の作成・参加・スタッツの読み取りで同じことを確かめる）。中は「フレンドマッチを開始」（PRIVATE MATCH と同じく部屋番号と招待 URL で募集。Discord で共有する）・部屋番号で入る・STATS・RANKING。結果（順位・pt・ハンドの集計）だけはサーバーに残り、メンバー全員のスタッツ（Kagaribi Stat Hub と同じ項目：合計・平均・加点率・1 位率・平均順位・参加・生存ターン。シーズン内／シーズン推移）とランキングになる。どちらもゲームモードごと（`src/friend.js`・`src/ui/friend.js`・`server/game/discord.js`）。
- **チャット**: PRIVATE MATCH と FRIEND MATCH の卓にはチャットがある（FREE MATCH には無い）。全角 40 文字まで（吹き出し 1 つは全角 20 文字。長い発言は均等に分けて順に出す）。履歴は部屋と一緒に消える。
- **部屋の設定**: ポーカーチェイスの SIT & GO（pocket-ICM の設定をそのまま）。人数 2〜6・初期チップ 10000/15000/20000/30000 枚・構造 3 種（3 分ごとに上昇）・ゲームモード（順位 → pt。6 人卓の表を人数ぶんに等分して平均を取るので、どの人数でも 1 人あたりの平均 pt は同じ。`payoutsFor`）。
- **ベットサイズ**: ヘッダの歯車／メニューの SETTINGS（入口 → ベットサイズ）で、Bet / Raise のシートの候補（BB・x・%）とスライダーの刻みを変えられる（端末に保存。`src/betsize.js`）。
- **演出 GIF**: SETTINGS（入口 → 演出 GIF）で KLIPY の GIF を 1 つ選べる（任意。端末に slug だけ保存）。PRIVATE MATCH と FRIEND MATCH だけ、ショーダウンで勝った人（チョップを除く）の GIF を、勝負が決まって一間おいてから卓の中央に出し、消してからチップを勝者へ動かす。KLIPY の規約（API もメディアもブラウザから直接・URL は保存しない・結果を並べ替えない・検索欄は「Search KLIPY」）を守る（`src/klipy.js`・`src/ui/fxshow.js`）。
- **自動更新**: 新しい版が配信されると、開いたままのアプリ（ホーム画面に追加したものも）が自動で読み込み直す。メニューに居るときだけで、待機室・試合中・入力の途中には行わない。新しい版で起動すると「バージョンを更新しました」と出る（`src/update.js`・`src/ui/update.js`）。
- **記録**: 成績とハンド履歴は端末（IndexedDB）に保存する。サーバーの記録は端末へ渡すまでの一時置き場（終局から 3 日で消える）。FRIEND MATCH の結果（1 試合 × 1 人の順位・pt・ハンド数・VPIP / PFR の回数）だけはサーバーに残す。
- **スタッツ**: STATS はゲームモードごと（モードをまたいで混ぜない）。VPIP・PFR・生存ターン（ハンド数 ÷ VPIP(%) × 100 ÷ 試合数）。卓で席を押すとその人のスタッツとメモ・色の印（端末に保存。`src/ui/player.js`・`src/history/notes.js`）。
- **参考**: UI・認証・サーバー構成は satsuki19980613/Multiplier、ゲーム設定とスタッツ画面は satsuki19980613/pocket-ICM、FRIEND MATCH のスタッツの項目と形は satsuki19980613/Kagaribi-Stat-Hub。
- **実装契約**: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。セットアップとデプロイ: [docs/SETUP.md](docs/SETUP.md)。

## 2. コマンド
| 目的 | コマンド |
|---|---|
| セットアップ | `npm install` |
| 開発サーバー | `npm run dev`（http://localhost:5180。**`?fake` でサーバー無しに全画面を確認できる**。`&allin`：Bot がよくオールインする（ランアウトの演出）、`&short`：初期スタック 2〜4 BB ですぐ終局（再戦）、`&nofriend`：FRIEND MATCH の Discord の確認がまだの人として始める。本番でも `/?demo` でログインなしに Bot と打て、メニューの SHOWCASE から「オールイン（毎回リバーまで勝負が残る）」「3 人で打つ」「再戦」をすぐ始められる） |
| 単体テスト | `npm test`（`TEST_DATABASE_URL` があれば DB の結合テストも） |
| ビルド | `npm run build` |
| デプロイ | `main` への push で GitHub Actions の Deploy（Neon）→ 住所をコミット → Cloudflare Pages の GitHub 連携がサイトを公開（docs/SETUP.md） |

## 3. 規約
- ルールを変えるときは `src/engine.js` だけを直し（設定は `src/structure.js`）、`npm test` を通す。サーバーとブラウザで二重に実装しない。
- 山札と他席の手札はブラウザに送らない（`viewFor`）。
- 画面に説明文を出さない。説明はルールのモーダルに集める。ポーカー用語は英語（Fold / Call / Raise）。
- 角は直角。色は YOU #336B87・相手 #FE7A47（チャットの発言者だけは席ごとの 5 色 `--pc1`〜`--pc5`）。トークンは `src/style.css` の `:root`。
- 秘密情報（API キー、DB の接続文字列、Discord のクライアントシークレット）はコミットしない。GitHub の Secrets に置く（docs/SETUP.md）。
- マイグレーションは追加のみ（適用済みのファイルは書き換えない）。
- コミットメッセージは `feat(scope): …` / `fix(...)` / `docs(...)` / `chore(...)` の形で、日本語で書く。
