# PrivateMatch — アーキテクチャと実装契約

モジュール間のインターフェースはこの文書で固定する。変える場合はこの文書を先に更新する。
技術構成は Multiplier（satsuki19980613/Multiplier）、ゲームの設定とスタッツ画面は pocket-ICM（satsuki19980613/pocket-ICM の SIT & GO）を踏襲する。

## 0. 全体像

```
ブラウザ (Vite + 素の JS)                          Cloudflare Pages
  index.html / src/main.js / src/style.css         functions/api/auth/[[path]].js … Neon Auth への中継（Cookie をファーストパーティに）
  src/net.js ── /api/auth/* ──────────────────▶
             ── Data API RPC（読み取り）───────▶  Neon Postgres（RLS 有効・RPC 関数だけ公開）
             ── Function "game"（書き込み）────▶  Neon Function server/game/index.js
  src/history/* ── IndexedDB（成績・ハンド履歴の正本）
共有ロジック: src/structure.js（設定）/ src/engine.js（ルール）/ server/game/rules.js（部屋）
開発専用: src/fakeNet.js（?fake でサーバー無しに全画面を確認。本物の rules.js とエンジンをブラウザで動かす）
```

- ルールは `src/engine.js` にだけ実装する（サーバーとブラウザで二重に実装しない）。
- サーバーが権威を持つ。山札と他席の手札はブラウザに送らない（`viewFor`）。
- 同期は HTTP ポーリング。常駐プロセスは無いので、時間切れ・次のハンド・一時停止の期限は遅延評価（席の誰かが `tick` を呼ぶ）。

## 1. カード
整数 `0..51`。`rank = c >> 2`（0='2' … 12='A'）、`suit = c & 3`（0♠ 1♥ 2♦ 3♣）。

## 2. `src/structure.js` — 設定（pocket-ICM の SIT & GO そのまま）
- 人数 2/3/4/5/6、開始スタック 75/100/150/200 BB（レベル 1 の BB = 200 チップ）、ブラインド構造 `normal`(16) / `slow`(32) / `veryslow`(59)、上昇間隔 3/4/5 分。
- SB = BB/2、アンティは表の値を全員が払う。`level = min(表の長さ, floor((now − startedAt) / levelMs) + 1)` をハンド開始時に評価。
- ゲームモード（順位 → pt）：`club` `rank-3` `rank-4` `rank-5` `legend-avg` `legend-season` `legend-base`。pt は `payouts.slice(0, players)[place − 1]`。
- 時間：1 アクション 15 秒、タイムバンク 30 秒（1 試合・補充なし）、自動処理 2 回連続で sitout、ハンド間 3 秒、募集 15 分、一時停止 10 分。

## 3. `src/engine.js` — 2〜6 人の NLHE SIT & GO（純関数・決定論的）

```js
newTable({ config, names, now, rnd?, button?, stacks? }) // => st（第 1 ハンドを配った状態）
legalActions(st, seat?)  // => null | { seat, canFold, canCheck, toCall, callPut, minTo, maxTo, aggression, pot, streetLastBetTo }
act(st, seat, move, now) // move: { type: 'fold'|'check'|'call'|'raise'|'allin', to? }（raise は bet も兼ねる。to はそのストリートの「〜まで」）
tick(st, now)            // 期限を過ぎたものを 1 つ進める（時間切れ / 次のハンド / 一時停止の期限）。無ければ EngineError('not_yet')
sitout(st, seat, now) / sitin(st, seat, now) / leave(st, seat, now)
dueAt(st)                // 次に何かが起きる時刻
handRecord(st)           // 精算済みハンドの { rec, holes }
viewFor(st, seat)        // 山札・鍵・他席の手札（公開分以外）を消したもの
```

状態 `st`：`{ ver, config, n, names, startedAt, players: [{ stack, status, timeBankMs, autoCount, place, pt }], handNo, prevSbPos, prevBbSeat, seed, ctr, hand, nextAt, status, pausedAt, endedAt, winner }`
- `status`：`running` | `paused` | `finished` | `cancelled`。プレイヤーの `status`：`active` | `sitout` | `left` | `out`。
- `hand`：`{ handNo, level, sb, bb, ante, btn, sbSeat, bbSeat, street(0-3), deck, hole, board, startStacks, commits, streetBet, folded, allIn, toAct, streetLastBetTo, lastBetSize, actions: [{ seat, kind, betTo, put, auto, street }], turnStart, deadline, phase('betting'|'settled'), won, shown, names, pots, eliminated, startedAt, endedAt }`
- `players[s].stack` はハンド中も拠出を引いた値（不変条件：Σstack + Σcommits = n × 開始スタック）。

ルール（pocket-ICM SNG_DESIGN §1）
- デッドボタン：`bb = nextLive(前の bb)`、`sb = 前の bb`（飛んでいれば SB 無し）、`btn = 前の SB の位置`。HU はボタン = SB。
- 手番：プリフロップは BB の次、ポストフロップはボタンの次から。アンティ → ブラインドの順に `min(stack, 額)`。
- 最小レイズ = 直前の上乗せ幅（最低 BB）。最小レイズ未満のオールインは、すでに動いた席のレイズ権を再開しない。
- 動ける席が 1 人以下になったらボードを最後まで配る。ショーダウンは全員表向き。サイドポットは拠出額のレイヤごと、端数はボタンの次から。
- 同じハンドで複数人が飛んだら開始時スタックの多い方が上位。
- sitout / left の席は手番が来た瞬間に自動処理（チェックできればチェック、それ以外はフォールド）。
- 退出（left）で残りが 1 人になったらその人の勝ちで終了（退出した席はスタックの多い順に残りの順位）。
- 生存者が全員 sitout ならハンド間で一時停止、10 分で中止。

## 4. `server/game/rules.js` — 部屋（純関数。fakeNet も使う）
`room = { id, code, kind: 'private'|'free', host, config, status, started, members, names, state, ver, createdAt, startedAt }`
- `createRoom` / `joinRoom`（満席で席をシャッフルして開始）/ `leaveRoom`（待機中は離れる。作成者なら中止。進行中は left）
- `applyRequest(room, uid, { op: 'act', ver, move } | { op: 'sitout' } | { op: 'sitin' }, now)` / `tickRoom(room, uid, now)` → `{ room, record }`
- `viewsOf(room)`：開始前は `[待機室]`、開始後は席ごとのビュー（`{ ...viewFor, ver: room.ver, room: roomInfo }`）。

## 5. HTTP（`server/game/handler.js`。POST のみ・Bearer JWT 必須）
| op | body | 返り値 |
|---|---|---|
| `create` | `{ kind, config }` | `{ room, ver, now, view }` |
| `join` | `{ code }` | 同上（すでに居れば今の部屋） |
| `leave` | `{ room }` | 同上 |
| `act` | `{ room, ver, move }` | 同上 |
| `sitout` / `sitin` | `{ room }` | 同上 |
| `tick` | `{ room }` | 同上（何も無ければ 409 `not_yet`） |

エラー：`in_other_room`（`room` 付き）、`room_full`、`room_closed`、`not_found`、`stale`、`not_your_turn`、`game_over`、`busy`、`illegal`、`malformed`。

## 6. DB（`db/migrations/*.sql`、追加のみ）
| 表 | 内容 |
|---|---|
| `profiles` | uid、nickname（1〜16・大文字小文字を無視して一意） |
| `rooms` | code（6 桁。生きている部屋の中で一意）、kind、host、config、status、started、members、names、state、ver、views、due_ms |
| `room_hands` | 終わったハンドの記録（端末へ渡すまでの一時置き場）。終局から 3 日で部屋ごと消える |

RPC（`authenticated` のみ）：`me()`（プロフィール・居る部屋・3 日以内の部屋）、`set_nickname`、`room_poll(p_room, p_ver)`、`room_peek(p_code)`、`free_rooms()`、`room_hands(p_room, p_after)`（自分の手札だけ `hole` に入る）。

## 7. 端末の記録（`src/history/*`）
- IndexedDB `privatematch`：`games`（1 試合 1 件）と `hands`（`[roomId, handNo]`）。
- 卓ではハンドが終わるたびに `room_hands` を差分で読み、終局時に試合の結果を保存する。起動時は `me().recent` を見て取りこぼしを埋める。
- STATS：試合数・平均順位・1 位率・入賞率（pt > 0）・累計 pt・直近の成績、順位分布、累計 pt のグラフ（期間：直近 100/500/1000/全期間）。HAND HISTORY：試合ごとの一覧 → ハンドの詳細。EXPORT / IMPORT（JSON）。

## 8. 画面
- メニュー：PRIVATE MATCH（部屋を作る / 部屋番号で入る）、FREE MATCH（部屋を作る＋募集中の一覧）、STATS。ランキングは無い。
- 待機室：部屋番号・招待 URL（`/?room=123456`。Copy / 共有）・参加者・満席で自動開始。
- 卓：2〜6 席の楕円（自分は下）、操作は Fold / Check / Call / Bet・Raise（プリセット＋スライダー）、Check/Fold の予約、離席 / I'm back、Leave。
- デザインは Multiplier：直角、YOU #336B87、相手 #FE7A47、ライト／ダーク、ガラス質感、`fitTable` による実測フィット。
