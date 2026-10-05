# CLAUDE.md — PrivateMatch

このリポジトリで作業するセッションが最初に読む文書。

## 1. 概要
- **アプリ**: PrivateMatch。知り合いと気軽にポーカー（NLHE）の SIT & GO を遊ぶ。完全無料・課金なし。
- **メニュー**: PRIVATE MATCH（部屋を作る → 部屋番号と招待 URL が出る / 部屋番号で入る）、FREE MATCH（公開の部屋を作る＋募集中の一覧）、STATS（成績とハンド履歴）。ランキングは無い。Google ログイン必須。
- **チャット**: PRIVATE MATCH の卓にはチャットがある（FREE MATCH には無い）。全角 20 文字まで。履歴は部屋と一緒に消える。
- **部屋の設定**: ポーカーチェイスの SIT & GO（pocket-ICM の設定をそのまま）。人数 2〜6・初期チップ 10000/15000/20000/30000 枚・構造 3 種（3 分ごとに上昇）・ゲームモード（順位 → pt）。
- **記録**: 成績とハンド履歴は端末（IndexedDB）に保存する。サーバーの記録は端末へ渡すまでの一時置き場（終局から 3 日で消える）。
- **参考**: UI・認証・サーバー構成は satsuki19980613/Multiplier、ゲーム設定とスタッツ画面は satsuki19980613/pocket-ICM。
- **実装契約**: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。セットアップとデプロイ: [docs/SETUP.md](docs/SETUP.md)。

## 2. コマンド
| 目的 | コマンド |
|---|---|
| セットアップ | `npm install` |
| 開発サーバー | `npm run dev`（http://localhost:5180。**`?fake` でサーバー無しに全画面を確認できる**） |
| 単体テスト | `npm test`（`TEST_DATABASE_URL` があれば DB の結合テストも） |
| ビルド | `npm run build` |
| デプロイ | `main` への push で GitHub Actions の Deploy（Neon）→ 住所をコミット → Cloudflare Pages の GitHub 連携がサイトを公開（docs/SETUP.md） |

## 3. 規約
- ルールを変えるときは `src/engine.js` だけを直し（設定は `src/structure.js`）、`npm test` を通す。サーバーとブラウザで二重に実装しない。
- 山札と他席の手札はブラウザに送らない（`viewFor`）。
- 画面に説明文を出さない。説明はルールのモーダルに集める。ポーカー用語は英語（Fold / Call / Raise）。
- 角は直角。色は YOU #336B87・相手 #FE7A47（チャットの発言者だけは席ごとの 5 色 `--pc1`〜`--pc5`）。トークンは `src/style.css` の `:root`。
- 秘密情報（API キー、DB の接続文字列）はコミットしない。GitHub の Secrets に置く（docs/SETUP.md）。
- マイグレーションは追加のみ（適用済みのファイルは書き換えない）。
- コミットメッセージは `feat(scope): …` / `fix(...)` / `docs(...)` / `chore(...)` の形で、日本語で書く。
