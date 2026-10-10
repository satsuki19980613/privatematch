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
共有ロジック: src/structure.js（設定）/ src/engine.js（ルール）/ server/game/rules.js（部屋・再戦）/ src/chat.js（チャットの文字の決まり）/ src/equity.js（演出の勝率）/ src/pace.js（卓の遷移の間と順番）/ src/betsize.js（ベットサイズの設定と候補の額）/ src/fx.js（演出 GIF の slug とメディアの選び方）
演出 GIF:  src/klipy.js ── KLIPY API（api.klipy.com。ブラウザから直接）／メディアは static*.klipy.com からブラウザが直接（サーバー・Service Worker を通さない）
開発・デモ: src/fakeNet.js（?fake（開発）/ ?demo（本番も）でサーバー無しに全画面を確認。本物の rules.js とエンジンをブラウザで動かす。
          デモのメニューの SHOWCASE：river = 4 人・自分 100BB・Bot 15BB、先に動く Bot がオールインしてほかは降り、配りはターンで 2 人に勝ちの目が残るもの（半分はリバーで逆転）を乱数の鍵を選び直して作る／flow = 3 人・普通の速さ／rematch = 3 人・2〜4BB・Bot は全員席に残る）
```

- ルールは `src/engine.js` にだけ実装する（サーバーとブラウザで二重に実装しない）。
- サーバーが権威を持つ。山札と他席の手札はブラウザに送らない（`viewFor`）。
- 同期は HTTP ポーリング。常駐プロセスは無いので、時間切れ・次のハンド・一時停止の期限は遅延評価（席の誰かが `tick` を呼ぶ）。

## 1. カード
整数 `0..51`。`rank = c >> 2`（0='2' … 12='A'）、`suit = c & 3`（0♠ 1♥ 2♦ 3♣）。

## 2. `src/structure.js` — 設定（pocket-ICM の SIT & GO そのまま）
- 人数 2/3/4/5/6、初期チップ 10000/15000/20000/30000 枚 = `startBb` 50/75/100/150（レベル 1 の BB = 200 チップ）、ブラインド構造 `normal`(16) / `slow`(32) / `veryslow`(59)。上昇間隔は選べず 3 分（`LEVEL_MS`。以前の部屋の `config.levelMin` はその値）。
- SB = BB/2、アンティは表の値を全員が払う。レベルはハンド開始時に `nextLevel` で決める：`now − levelStartAt ≥ 3 分` なら前のハンドのレベル + 1（表の長さまで）にして `levelStartAt = now`（ポーカーチェイスと同じく、3 分たつとタイマーが止まり、次のハンドから上がってそこから数え直す）。
- ゲームモード（順位 → pt）：`club` `rank-3` `rank-4` `rank-5` `legend-avg` `legend-season` `legend-base`。pt は `payouts.slice(0, players)[place − 1]`。
- 時間：1 アクション 15 秒、タイムバンク 30 秒（1 試合・補充なし）、自動処理 2 回連続で sitout、ハンド間 2.5 秒（長すぎるという声で 3 秒から縮めた。ショーダウンなら + `runoutMs(runFrom)`）、募集 15 分、一時停止 10 分、再戦の受付 15 分（作成者を待つのは 1 分）。
- 勝者の演出 GIF `FX = { wait 600, in 280, show 2600, out 576, gap 450 }`（ms）、`FX_MS` = その合計 4506（out と gap は消えてからが速すぎるという声で 1.8 倍にした）。勝負が決まってから GIF までの一間（wait）は GIF を出すハンドだけで、出さないハンドは間をおかずに結果へ。出す席（`fxSeat`）があるショーダウンは、エンジンが次のハンドを `FX_MS` だけ遅らせる。
- ショーダウンの演出 `RUNOUT = { gather 900, reveal 1400, flop 3060, street 1700, river 2000, show 800, latency 800, preflop 600 }`（ms）。`runoutMs(from)` = from < 5 なら gather + reveal + （フロップ・ターン（street）のうち未公開の分）+ river + latency（from = 0 はプリフロップの後の一間 preflop も）、普通のショーダウン（from = 5）は gather + show + latency。プリフロップのオールインで 10.5 秒、普通のショーダウンで 2.5 秒。river は勝率が決まるまで（表が見えるのは 1.75 秒）で、結果へは間をおかずに進む。gather と flop は速すぎるという声で 1.8 倍にした（もとは 500 / 1700）。他アプリのストリート間隔（1〜3 秒・中央値 2 秒前後。1 秒以下だと何が起きたか分からないという声）を元に決めた。

## 3. `src/engine.js` — 2〜6 人の NLHE SIT & GO（純関数・決定論的）

```js
newTable({ config, names, now, rnd?, button?, stacks?, fx? }) // => st（第 1 ハンドを配った状態）。fx = 席ごとの演出 GIF の slug | null（無い・全員 null なら st.fx = null）
legalActions(st, seat?)  // => null | { seat, canFold, canCheck, toCall, callPut, minTo, maxTo, aggression, pot, streetLastBetTo }
act(st, seat, move, now) // move: { type: 'fold'|'check'|'call'|'raise'|'allin', to? }（raise は bet も兼ねる。to はそのストリートの「〜まで」）
tick(st, now)            // 期限を過ぎたものを 1 つ進める（時間切れ / 次のハンド / 一時停止の期限）。無ければ EngineError('not_yet')
sitout(st, seat, now) / sitin(st, seat, now) / leave(st, seat, now)
dueAt(st)                // 次に何かが起きる時刻
handRecord(st)           // 精算済みハンドの { rec, holes }
viewFor(st, seat)        // 山札・鍵・他席の手札（公開分以外）を消したもの（fx はそのまま全員に見える）
fxSeat(hand, fx)         // 演出 GIF を出す席：精算済みのショーダウンで取り分（won − 拠出）がいちばん多い 1 人。GIF 無し・チョップ・フォールドで終わった・fx 無しは null
```

状態 `st`：`{ ver, config, n, names, startedAt, levelStartAt, players: [{ stack, status, timeBankMs, autoCount, place, pt }], handNo, prevSbPos, prevBbSeat, seed, ctr, hand, nextAt, status, pausedAt, endedAt, winner, fx }`
- `status`：`running` | `paused` | `finished` | `cancelled`。プレイヤーの `status`：`active` | `sitout` | `left` | `out`。
- `hand`：`{ handNo, level, sb, bb, ante, btn, sbSeat, bbSeat, street(0-3), deck, hole, board, startStacks, commits, streetBet, folded, allIn, toAct, streetLastBetTo, lastBetSize, actions: [{ seat, kind, betTo, put, auto, street }], turnStart, deadline, phase('betting'|'settled'), won, shown, names, pots, eliminated, runFrom, startedAt, endedAt }`
- `runFrom`：ショーダウンで手札を表にした時点のボードの枚数（動ける席が 1 人以下になって残りを配るときはその時点の 0/3/4、普通のショーダウンは 5、フォールドで終われば null）。精算後の `nextAt = endedAt + BETWEEN_HANDS_MS + runoutMs(runFrom) + (fxSeat(hand, fx) != null ? FX_MS : 0)`。
- `players[s].stack` はハンド中も拠出を引いた値（不変条件：Σstack + Σcommits = n × 開始スタック）。

ルール（pocket-ICM SNG_DESIGN §1）
- デッドボタン：`bb = nextLive(前の bb)`、`sb = 前の bb`（飛んでいれば SB 無し）、`btn = 前の SB の位置`。HU はボタン = SB。
- 手番：プリフロップは BB の次、ポストフロップはボタンの次から。アンティ → ブラインドの順に `min(stack, 額)`。
- プリフロップのコールすべき額は BB 満額（BB がショートでオールインでも）。ただし配った時点で動ける人が 1 人だけなら、出ている最高額に合わせれば足りる。
- 最小レイズ = 直前の上乗せ幅（最低 BB）。最小レイズ未満のオールインは、すでに動いた席のレイズ権を再開しない。レイズできないときの `allin` はコールとして記録する。
- 動ける席が 1 人以下になったらボードを最後まで配る（`runFrom` に配る前の枚数を残す）。ショーダウンは全員表向き。サイドポットは拠出額のレイヤごと（対象者が同じ隣接レイヤは 1 つのポット）、端数はポットごとにボタンの次から。
- 同じハンドで複数人が飛んだら開始時スタックの多い方が上位。
- sitout / left の席は手番が来た瞬間に自動処理（チェックできればチェック、それ以外はフォールド）。
- 退出していない生存者（active / sitout）が 1 人になったら（退出でも脱落でも）その人の勝ちで終了。退出した席は（進行中のハンドの拠出を戻した）スタックの多い順に残りの順位。
- 生存者が全員 sitout ならハンド間で一時停止、10 分で中止。

## 4. `server/game/rules.js` — 部屋（純関数。fakeNet も使う）
`room = { id, code, kind: 'private'|'free', host, config, status, started, members, names, fx, state, ver, createdAt, startedAt, rematch }`
- `fx`：席ごとの演出 GIF（KLIPY の slug | null。`members` と同じ順）。PRIVATE MATCH だけ持ち、FREE MATCH は全員 null（正しくない slug も null。`src/fx.js` の `normalizeFx`）。`createRoom({ …, fx })` / `joinRoom(…, fx)` で入り、開始時に席と一緒に並べ替えてエンジンへ（誰も設定していなければ渡さない）。待機中に抜けた人の分は消える。以前の部屋は `fx` が無い（`fxOf` は全員 null）。
- `createRoom` / `joinRoom`（満席で席をシャッフルして開始）/ `leaveRoom`（待機中は離れる。作成者なら中止。進行中は left。終局後・飛んだ後は再戦の対象から外れる＝`rematch.gone`）
- `applyRequest(room, uid, { op: 'act', ver, move } | { op: 'sitout' } | { op: 'sitin' }, now)` / `tickRoom(room, uid, now)` → `{ room, record }`
- `viewsOf(room)`：開始前は `[待機室]`、開始後は席ごとのビュー（`{ ...viewFor, ver: room.ver, room: roomInfo, rematch }`。rematch は終局後だけ `{ stay, gone, next, host, closesAt }`、それ以外は null）。
- 再戦：`room.rematch = { stay: [席]（残った順）, gone: [席], next: { id, code } | null }`。
  - `stayRoom(room, uid, now, fx?)`：fx（undefined でなければ）は再戦で使う GIF（試合の途中で設定を変えた分。もう残っていれば GIF だけ書き換え、ver は変えない）。終局（finished）から `REMATCH_MS` 以内で、まだ next が無く、途中で退出していない（left でない）人が席に残る。それ以外は `room_closed`。
  - `rematchLeader({ stay, gone, host }, endedAt, now)`：作成者が残っているか、去っておらず（gone にも left にもならず）終局から `REMATCH_HOST_WAIT_MS` 以内なら作成者の席。そうでなければ先に残った人の席（いなければ null）。ブラウザもビューの rematch で同じ関数を使う。
  - `rematchRoom(room, uid, { id, code, names, busy, fx? }, now, rnd)` → `{ room, next }`：GIF は残った人の `room.fx`（押した人は fx を送ればそれ）。再戦を始められる席の人だけ（`not_host`）。押した人も残ったことになる。残った人からほかの部屋に居る人（busy）を除き、2 人未満なら `not_enough`。`next` は同じ kind・同じ設定で人数 = 残った人数、作成者 = 押した人、名前は今の表示名、席はシャッフルして開始済み。元の部屋は `rematch.next` を入れて ver + 1。
- `postChat(room, uid, text, lastAt, now)` → `{ seat, text }`（text は `normalizeChat` 済み。room は変えない）。メンバーでない → `not_found`、private でない・未開始 → `chat_closed`、文が不正 → `malformed`、同じ席の前の発言（`lastAt`）から 1 秒未満 → `too_fast`。終局後も部屋がある限り送れる。

チャットの文字（`src/chat.js`。サーバーとブラウザの入力欄が共有）
- 幅の単位：全角（East Asian Width の W / F 相当・絵文字）= 2、それ以外 = 1（コードポイント単位）。上限 `CHAT_MAX_UNITS = 80`（全角 40 文字 / 半角 80 文字。20 文字では足りないという声で 2 倍にした）。吹き出し 1 つは `BUBBLE_MAX_UNITS = 40`（全角 20 文字）までで、長い発言は `splitChat` で分ける：数は最少、長さはなるべく均等（最後だけ短い切れ端にしない）、切れ目は均等な位置に近い空白・句読点の後ろ（幅の 15% までずれてよい）、書記素の途中では切らない。分けた吹き出しは、前の分を読む時間（`dwell`）をおいてから次の分に入れ替える。同じ席の連投は `CHAT_MIN_INTERVAL_MS = 1000` 以上あける。1 部屋 `CHAT_ROOM_MAX = 2000` 件まで。
- `normalizeChat(s)`：空白類（改行・タブ・NBSP・全角スペースなど）は半角スペースに、制御文字と見えない文字・ゼロ幅・方向制御（`set_nickname` と同じ集合。絵文字どうしをつなぐ ZWJ だけは残す）は削除、NFC、連続スペースは 1 つ、前後を削る。空・上限超え・文字列でなければ `null`（切り詰めない）。
- `chatUnits(s)` で幅を数え、`clipChat(s)` で入力欄を上限まで切る（書記素の途中では切らない）。

## 5. HTTP（`server/game/handler.js`。POST のみ・Bearer JWT 必須）
| op | body | 返り値 |
|---|---|---|
| `create` | `{ kind, config, fx? }` | `{ room, ver, now, view }` |
| `join` | `{ code, fx? }` | 同上（すでに居れば今の部屋） |
| `leave` | `{ room }` | 同上 |
| `act` | `{ room, ver, move }` | 同上 |
| `sitout` / `sitin` | `{ room }` | 同上 |
| `tick` | `{ room }` | 同上（何も無ければ 409 `not_yet`） |
| `fx` | `{ room, fx }` | 同上（部屋に入った後に演出 GIF を変えた。PRIVATE MATCH だけ反映し、進行中はエンジンにもすぐ入れて ver + 1。FREE MATCH・同じ値は何もしない） |
| `chat` | `{ room, text }` | `{ now, msg: { seq, seat, text, at } }`（ゲームの `ver` は変えない） |
| `stay` | `{ room, fx? }` | 同上（終局後に席に残る） |
| `rematch` | `{ room, fx? }` | 新しい部屋の `{ room, ver, now, view }`（席に残った人の profiles → 元の部屋の順にロック。ほかの部屋に居る人は除く） |

`fx`（演出 GIF の slug。ブラウザは PRIVATE MATCH のときだけ送る）は任意で、正しくなければ null として扱う（参加は止めない）。

エラー：`not_authenticated`（401）、`unavailable`（503。JWKS に届かない。ブラウザはログアウトしない）、`in_other_room`（`room` 付き）、`room_full`、`room_closed`、`not_found`、`stale`、`not_your_turn`、`game_over`、`busy`、`illegal`、`malformed`、`chat_closed`（409。FREE MATCH・開始前）、`too_fast`（429。同じ席の連投が 1 秒未満）、`chat_full`（409。1 部屋 2000 件）、`not_host`（409。再戦を始められる人でない）、`not_enough`（409。残った人が 2 人未満）、`too_many`（429。回数の制限）。

回数の制限（1 人ごと）：部屋番号のはずれ（`join` の `not_found` と RPC `room_peek` の null を合わせて）は 10 分に 10 回で、達すると窓が明けるまで `join` も `room_peek` も `too_many`（当たりの番号でも通さない）。`create` は成功した分が 10 分に 10 回。どちらも DB で数える（`rate_limits`）。ほかに、Function への連打を 1 人あたり毎秒 5 回・まとめて 40 回までにする（`deps.flood`。インスタンスのメモリの中で数えるので目安）。

## 6. DB（`db/migrations/*.sql`、追加のみ）
| 表 | 内容 |
|---|---|
| `profiles` | uid、nickname（1〜16・大文字小文字を無視して一意。制御文字・ゼロ幅・方向制御は不可） |
| `rooms` | code（6 桁。生きている部屋の中で一意）、kind、host、config、status、started、members、names、state、ver、views、due_ms、rematch（終局後の再戦の受付。`20261008000000_rematch.sql`）、fx（席ごとの演出 GIF の slug。`20261009000000_fx.sql`） |
| `room_hands` | 終わったハンドの記録（端末へ渡すまでの一時置き場）。終局から 3 日で部屋ごと消える |
| `room_chat` | チャットの発言（room, seq, seat, text, created_at）。書き込みは Function の `chat` だけ。部屋と一緒に消える。`rooms.chat_seq` が最新の seq |
| `rate_limits` | 回数の制限（uid × 種類 `code` / `create` ごとの窓の始まりと回数。上限と窓は `rate_rule`。`20261010200000_rate_limit.sql`） |

認証で届く個人の情報は残さない（`20261010000000_auth_scrub.sql`・`20261010100000_auth_scrub_profile.sql`）：Neon Auth が書く行を、書き込みのたびにトリガーで置き換える。`neon_auth."user"` の `email` は `<id>@privatematch.invalid`、`name` は `Player`、`image` は空。`neon_auth.account` の `idToken` / `accessToken` / `refreshToken` は空。`neon_auth.session` の `ipAddress` / `userAgent` は空。アプリはどれも使わない。残っていないかは `scripts/auth-audit.mjs`（Live が本番と dev で数える）。

RPC（`authenticated` のみ）：`me()`（プロフィール・居る部屋・終わってから 3 日以内の部屋）、`set_nickname`、`room_poll(p_room, p_ver)`（`chat` に最新の seq）、`room_peek(p_code)`（無ければ null で、はずれとして数える。上限に達していれば `too_many`）、`free_rooms()`、`room_hands(p_room, p_after)`（自分の手札だけ `hole` に入る）、`room_chat(p_room, p_after)`（`seq > p_after` の新しい方から最大 200 件を古い順に `[{ seq, seat, text, at }]`。メンバーでなければ `not_found`、private でなければ `[]`）。

## 7. 端末の記録（`src/history/*`）
- IndexedDB `privatematch`：`games`（1 試合 1 件）と `hands`（`[roomId, handNo]`）。
- 卓ではハンドが終わるたびに `room_hands` を差分で読み、終局時に試合の結果を保存する。起動時は `me().recent` を、STATS を開いたときは「途中」の試合を見て取りこぼしを埋める。
- 集計の対象は終局した試合と、飛んで順位と pt が決まった試合。IMPORT は書き出しと同じ形の行だけを受け付け、端末のほうが進んだ試合は上書きしない。
- STATS：ゲームモード（種類 → 段階）を選び、そのモードの試合だけで数える（`byMode`。pt も生存ターンもモードをまたいで混ぜない。選んだモードは localStorage `pm-stats-mode`、無ければ最後に終わった試合のモード）。試合数・平均順位・1 位率・入賞率（pt > 0）・累計 pt・直近の成績、HANDS・VPIP・PFR・生存ターン、順位分布、累計 pt のグラフ（期間：直近 100/500/1000/全期間。グラフ以外の数字にも効く）。HAND HISTORY：試合ごとの一覧 → ハンドの詳細。EXPORT / IMPORT（JSON。`notes` にプレイヤーのメモも入れる）。
- ハンドの集計（`src/history/stats.js`）：`handStats`（VPIP = プリフロップで自分から Call / Bet / Raise / チップを足すオールイン、PFR = それまでの最高額を超えて張った。自動処理は数えない）。`playerStats(games, handsOf, who)`：`who` = 名前（`nameKey`：NFC・前後の空白を除く・小文字。null は自分 = 各試合の `g.seat`）で試合ごとに席を引き（`seatIn`。相手を引くときは自分の席を除く）、その席が配られたハンドだけを数える（`gameHandStats` を試合ごとに作って `mergeStats` で足す。STATS は試合ごとの自分の集計だけを持ち、全ハンドは持ち続けない）。試合数はその人が 1 ハンド以上配られた試合。`survivalTurns` = ハンド数 ÷ VPIP(%) × 100 ÷ 試合数（VPIP 0・試合 0 は null）。端末の記録は全員のアクションを持つので、相手の数字も一緒に打った試合から数えられる。
- プレイヤーのメモ（`src/history/notes.js`）：localStorage `pm-notes`（デモは `pm-notes-demo`）に `{ [nameKey]: { name, mark: 0..6, text（200 文字まで）, at } }`（プロトタイプの無い入れ物。名前が `constructor` などでもよい）。印もメモも空なら消す。中身が変わらない書き込みは何もしない（`at` も変えない）。ほかのタブの書き換え（`storage`）で読み直す。IMPORT は壊れた行を捨て、`at` を今より先にせず、同じ人は `at` の新しい方を残し、3000 人まで。

## 8. 画面
- メニュー：PRIVATE MATCH（部屋を作る / 部屋番号で入る）、FREE MATCH（部屋を作る＋募集中の一覧）、STATS、SETTINGS。ランキングは無い。
- 設定（`src/ui/settings.js`、`#setDlg`）：ヘッダの歯車（メニューでも卓でも）とメニューの SETTINGS から開く。入口にベットサイズと演出 GIF の 2 つのボタン（← BACK で戻る）。演出 GIF を選べない（`VITE_KLIPY_KEY` が無く、デモでもない）ときは入口を出さずにベットサイズを開く。
- 演出 GIF（`src/ui/gif.js`）：選んだ slug だけを端末に保存（localStorage `pm-fx`。デモは `pm-fx-demo`）。部屋に入った後に変えたら op `fx` ですぐ部屋にも送る（`main.js`）。今の GIF と「なし」、検索欄（プレースホルダー「Search KLIPY」。入力の 0.45 秒後・Enter で検索、空ならトレンド）、結果の格子（API の順のまま。上の部分は止めたまま格子だけがスクロールし、下まで送ると次のページ）。選ぶと KLIPY の Share Trigger を送る。KLIPY の呼び出しは `src/klipy.js`（`content_filter=high`、`customer_id` は端末のランダムな値 `pm-klipy-cid`、メディアと URL は保存しない）。`?fake` / `?demo` は手元の見本（`src/fxDemo.js`。自作の動く SVG）を同じ形で返し、Bot も PRIVATE MATCH では 4 人に 3 人が見本の GIF を持つ。
- ベットサイズ：端末に保存（localStorage `pm-betsizes`）。スライダーの刻み（0.1/0.2/0.5/1/2/5 BB）と、場面ごとの候補（各 15 個まで）：Preflop Open（BB）、Preflop vs Raise（x = 直前のレイズ額の倍 / BB）、Postflop Bet（ポットの %）、Postflop vs Bet/Raise（x = 直前のベットの倍 / % = コール後のポットの割合を足す）。All-in は消せない。開いているベットのシートは変更で作り直す。
- 待機室：部屋番号・招待 URL（`/?room=123456`。Copy / 共有）・参加者・満席で自動開始。
- 卓：2〜6 席の楕円（自分は下）、操作は Fold / Check / Call / Bet・Raise（プリセット＋スライダー。プリセットは Min と設定の候補のうち Min と All-in の間に入るもので、横にスクロール。All-in は右端に固定）、Check/Fold の予約、離席 / I'm back、Leave。
- 卓のチャット（PRIVATE MATCH だけ）：入力ボタンはドックの近く。発言は発言した人の席の真上に吹き出しで出る（ふわっと出て消える。1 席に 1 つ）。ほかの席・ベット・ボード・ドック・情報の行・ほかの吹き出しに重ならない置き方を毎フレーム選ぶ：上（少し上へずらすときはしっぽの柄で席につなぐ）→ 札かプレートの横（しっぽは横向き）→ 下（しっぽは上向き）。形は標準・細め・横長と少し小さい文字（11px まで）、とても狭い卓では 1 行の帯（長い文は横に流れる）。それでも吹き出しどうしが重なれば古い方を先に消す（履歴には残る）。発言者の色は YOU と、自分から見た席の順の 5 色（`--pc1`〜`--pc5`）で、吹き出し・チャット履歴・席の合図で共通。スマホではキーボードに合わせて卓を縮める（小さすぎれば卓を縮小表示にし、吹き出しは読める大きさのまま）。キーボードの高さは画面の大きさごとに端末に覚え（localStorage `pm-kbh`）、2 回目からは入力欄を開いた瞬間にキーボードと同時に縮め始める（閉じるときも同時に戻す。`src/ui/viewport.js` の `expectKeyboard`）。送っても入力欄とキーボードはそのまま（続けて打てる）で、閉じるのは入力ボタン・×・外側を押したとき。デモ（`?demo`）で本物のキーボードが出ないとき（PC・開発者ツールのスマホ表示）は模擬キーボードを出して同じ縮み方を確かめられる。同期は `room_poll` の `chat` が増えたら `room_chat` を差分で読む。入室時の履歴は既読扱い。
- 卓の金額：ベット・ポット・ドックの POT / CALL / Call・Raise・ベットのシート・勝った額は BB（ポットは下にチップも）。席のプレートのスタックは BB かチップ数のどちらか一方（既定は BB）。スタックを押すと全員の席が切り替わり（両方を重ねて描き、320ms でふわっと入れ替える）、端末に保存する（localStorage `pm-stk`）。
- ショーダウンの演出（`src/ui/table.js`）：精算済みのビューは結果を一度に運ぶので、このハンドの賭けを見ていた卓（またはブラインドだけでオールインになって配った時点で精算済みのハンド）では `RUNOUT` の順に見せる。ベットをポットへ飛ばす（オールインなら ALL-IN の帯）→ 相手の手札を表に → 勝率の札（`equities`：残り 2 枚以下は全通り、それ以上はハンド番号を種にした 40000 回の試行。どの端末でも同じ値）→ フロップ（1 枚 828ms・270ms 刻みでゆっくり開き、開ききってから勝率）・ターン（開いて勝率を更新して止める）→ リバー（まだ 2 人以上に勝ちの目があれば、裏と表を背中合わせにした 1 つの立体の札を置き、端を -24° まで ease-in-out で持ち上げてから、速さ 0 から加速して -180° まで返す。途中で要素を差し替えず、角度は一方向にしか動かない。表が見えるのは置いてから 1.75 秒。決着していれば普通にめくって早めに結果へ）→ 勝者の 5 枚を浮かせ（1000ms）、ポットから勝者へ（1170ms）。演出の間は勝者・役名・増えたスタック・飛んだ順位・ドックの WINS・結果のダイアログ・端末への記録を伏せる（相手の表になった札も、ランアウトが始まる前の一拍を含めて、演出で返すまで裏）。ハンドが決まって自分が飛んだ・終局したときの結果のダイアログは、結果を見せてから 3 秒（`PACE.result`）おいて出す（ボードと勝者を見せる）。読み込み直し・裏に回っていたときは結果をそのまま出す。
- 勝者の演出 GIF（`src/ui/fxshow.js`。PRIVATE MATCH だけ）：卓のビューの `fx` が変わったら全席の分を `gifs/items` 1 回で引き、動く画像（webp。無ければ gif、それも無ければ動画）を先に読み込んでおく（iPhone の Safari は画面に出していない動画を先読みしないので、動画は使わない）。ショーダウンの演出で勝負が決まって（普通のショーダウンは手札を表にして `RUNOUT.show`、リバーは勝率が決まったところ）一間（`FX.wait`）おいてから、勝者（`fxSeat`）の GIF を卓の中央（卓の幅の 64%・440px まで、高さの 52% まで。縦横比は GIF のまま）に、まわりを暗くして出し、下に勝者の名前（YOU / 相手の色）。`FX.in` で出て `FX.show` 見せ、`FX.out` で消えてボードに戻り、`FX.gap` おいてから勝者の 5 枚・ポットから勝者へのチップ・順位。読み込みが終わっていなければ出さずにすぐ結果へ（進行は待たない）。卓を出ると読み込んだものを手放す。
- 遷移の間（`src/pace.js`）：受け取ったビューは列に並べ、前の遷移を見せ終わってから 1 つずつ当てる（`receive` → `pump` → `apply`。3 秒以上遅れたら最新へ飛ぶ。裏に回っている間は最新だけ）。`plan(prev, v)` が遷移の種類（action / street / win / showdown / deal / deal-showdown）と時刻を決め、卓はその順に見せる。
  - action：まとめて来た複数のアクションも 1 拍（550ms）ずつ。チップと札は 220ms で出し、まだ見せていないベットはスタックに残して見せる。手番の合図と操作ボタンは最後のアクションから 1 拍後。
  - street：最後のベット（コールで閉じたときもそのチップ）を 300ms 見せ → 612ms でポットへ集める → 160ms 空けて新しい札を返す（フロップは 1 枚 468ms・198ms 刻み、ターン・リバーは 260ms）→ 手番。フロップで約 2 秒。
  - プリフロップのアクションが終わったとき（街が進む・ショーダウン・フォールドで決着）は、最後のアクションを見せてから一間（`PACE.preflop` 600ms）おいてから集める（間が無いという声）。
  - win / showdown：最後のベットを見せて集めるまで結果を伏せ、win はそれからポットを勝者へ（チップは 1170ms で飛ぶ）、showdown は演出へ。deal：1 枚 360ms・144ms 刻みで配り終えてから手番（6 人で約 1.9 秒）。
  - 配る・チップが動く・フロップは、実際に遊んで速すぎるという声で 1.8 倍にした（2026-10。もとは 200/80・340・650・260/110）。
  - ドックの形：ハンドに参加して動ける間は、自分の番（上の段に YOUR TURN・POT・CALL・持ち時間、下の段に Fold / Check・Call・Raise）も待っている間（上の段に次に動く人と離席、下の段の左に Check/Fold の予約）も同じ 2 段で、相手が動いても・遷移の途中でも形を変えない（ちらついて見づらいという声）。Check/Fold の予約は自分の番の Fold / Check と同じ位置にあり、番が来た瞬間に押しても意図どおりになる（チェックボックスは付けず、予約中はボタン自体の色が反転する）。降りた・オールイン・参加していないハンドは 1 段。
  - ドックの中身が変わるとき（待っている間 ↔ 自分の番・結果など）は、前の表示の写しを重ねて 200ms で溶かし、新しい表示を 280ms で浮かび上がらせる（ふわっと切り替える。Check/Fold の予約を押したときは除く）。
  - 操作ボタンは出てから 400ms は押せない（見た目は変えない）。相手のアクションから押せるまで約 0.95 秒。遷移の途中・次のビュー待ちの間は操作ボタンを出さず（待っている間の形のまま）、押しても何も起きない。
  - 間の根拠：連続する出来事は 550ms 以上（attentional blink を越え、自然なテンポ 500〜650ms）、1 つの動きは 200〜400ms（Material・NN/g）、ボタンが出てからのロックは 350〜500ms（Chrome の許可ダイアログ 500ms）、出来事から押せるまで 1 秒以内（Nielsen）。
  - ベットのシートは 1 枚だけ：開いている間の Raise は閉じる（開く途中 240ms の連打は無視）、Back はいつでも閉じる、Call / Check / Fold を押す・手番が移る・街やハンドが変わる・遷移を見せ始めると閉じる（閉じる動き 200ms）。
- 観戦（飛んだ後・終局後）：ヘッダの Leave は確かめてからメニューへ（再戦の対象から外れる。席に残って待っていれば、その待ちから外れると出す）。ドックは WATCHING / GAME OVER・順位・Result（Menu は Leave と重なるので出さない）。
- 終局した卓は、結果のダイアログを出したところで片付ける：ボード・手札・ベット・ポットをふわっと消し、席には順位だけ、NEXT のタイマーは止めて「–」。
- 終局後：結果のダイアログに「席に残る」と Menu。残るとダイアログを閉じて卓に戻り、ドックに REMATCH（残った人数）と、再戦を始められる人には Rematch（2 人以上）、ほかの人には待機の点（ドックに Menu は出さない。抜けるのはヘッダの Leave）。席のプレートに STAY。ポーリングは受付の間 1.5 秒ごとに続け、`rematch.next` が出たら残った人は新しい卓へ。Menu は `leave` を送って去った扱いにする（飛んだ後の Menu も同じ）。
- 卓のヘッダ：チャット履歴（未読バッジ）とこの試合のハンド履歴のボタン。どちらも中央のすりガラスのモーダル（PC は Esc で閉じる）。
- プレイヤーのモーダル（`src/ui/player.js`、`#playerDlg`。同じすりガラス）：卓の席（札・プレート・ベット。スタックの行は単位の切り替え）を押す／フォーカスして Enter。その卓のモードで終わった試合の VPIP・PFR・生存ターン・HANDS（GAMES）と、この試合の HANDS・VPIP・PFR。相手の席なら色の印（なし＋6 色 `--mk1`〜`--mk6`）とメモ（入力の 0.4 秒後と閉じるときに保存）。印は席のプレートの菱形と左端の帯に出る（配置は変えない）。開いている間に自分の手番が来たら YOUR TURN（押すと閉じる。持ち時間は止まらない）。チャットの入力欄が開いているときの一押しは入力欄を閉じるだけ。スマホでメモを書く間はキーボードの上の見える範囲の上端へ寄せる。横向きの低い画面ではスタッツが左・メモが右の 2 列。
- デザインは Multiplier：直角、YOU #336B87、相手 #FE7A47、ライト／ダーク、ガラス質感、`fitTable` による実測フィット。
