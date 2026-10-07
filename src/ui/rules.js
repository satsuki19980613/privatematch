// ルールのモーダル：進行・持ち時間・ブラインド構造（3 種）・ゲームモードの pt。説明は画面に出さずここに集める。
import { BLIND_TABLES, SPEED_LABEL, SPEEDS, GAME_MODES, MODE_IDS, modeLabel, PLAYER_COUNTS, START_BBS, BASE_BB, LEVEL_MS, REMATCH_MS, REMATCH_HOST_WAIT_MS } from '../structure.js';
import { $, head, openDlg, fmt } from './util.js';

let tab = 'normal';
export function openRules() { paint(); openDlg('#rulesDlg'); }
function paint() {
  const t = BLIND_TABLES[tab];
  const blinds = t.map(([bb, ante], i) => `<span><i>${i + 1}</i>${fmt(bb / 2)}/${fmt(bb)} (${fmt(ante)})</span>`).join('');
  const modes = MODE_IDS.map(m => `<tr><td>${modeLabel(m)}</td>${GAME_MODES[m].payouts.map(v => `<td>${v > 0 ? '+' : ''}${v}</td>`).join('')}</tr>`).join('');
  $('#rulesBody').innerHTML = head('RULES', 'ルール') + `
    <h3>進行 <span>NO-LIMIT HOLD'EM ・ SIT &amp; GO</span></h3>
    <dl class="spec">
      <dt>部屋</dt><dd>PRIVATE MATCH は部屋番号か招待 URL で入れる部屋、FREE MATCH は一覧に公開されて誰でも入れる部屋です。作成者が決めた人数（${PLAYER_COUNTS.join('/')}人）が揃った瞬間に始まります。募集は 15 分で締め切られます。</dd>
      <dt>設定</dt><dd>ポーカーチェイスの SIT &amp; GO と同じです。初期チップ ${START_BBS.map(b => (b * BASE_BB).toLocaleString('en-US')).join('/')} 枚（${START_BBS.join('/')} BB。レベル 1 の BB = ${BASE_BB} 枚）、ブラインド構造 3 種。アンティは全員が払います。</dd>
      <dt>レベル</dt><dd>${LEVEL_MS / 60000} 分ごとに上がります。${LEVEL_MS / 60000} 分たつとタイマーが止まり、次のハンドから上のレベルになって、そこからまた数えます。</dd>
      <dt>ボタン</dt><dd>デッドボタン方式。ヘッズアップではボタンが SB です。</dd>
      <dt>持ち時間</dt><dd>1 アクション 15 秒。切れるとタイムバンク（1 試合 30 秒）を使います。尽きるとチェックかフォールドになり、2 回続くと離席扱いになります（I'm back で戻れます）。</dd>
      <dt>ショーダウン</dt><dd>残った全員が表向きにします。オールインで残りのボードを配るときは、手札と勝率を見せてから 1 枚ずつ開き（リバーは勝負が残っていれば伏せて置いてからめくります）、次のハンドはその分だけ待ちます。</dd>
      <dt>ベットサイズ</dt><dd>Bet / Raise のシートに並ぶ候補は SETTINGS（ヘッダの歯車）で変えられます（この端末に保存）。BB は BB の何倍まで、x は直前のベット/レイズの何倍まで、% はポットの何 %（ベットを受けているときは、コールした後のポットの何 % を足すか）です。Min と All-in はいつも出ます。スライダーの刻みも選べます。</dd>
      <dt>演出 GIF</dt><dd>PRIVATE MATCH だけ。SETTINGS の「演出 GIF」で選んでおくと、ショーダウンで勝ったとき（チョップを除く）に、勝負が決まってから卓の中央に出て全員に見えます。次のハンドはその分だけ待ちます。選ばなくても遊べます。部屋に入るときに GIF の番号だけを送り、変えた分は次の試合（再戦を含む）から使います。GIF は KLIPY が提供するもので、表示するためにブラウザが KLIPY（api.klipy.com・static.klipy.com）に直接つなぎます。</dd>
      <dt>表示</dt><dd>卓のベット・ポット・Call / Raise の額は BB で表示します（スタックはチップと BB）。</dd>
      <dt>退出</dt><dd>途中で退出すると戻れません。チップは卓に残り自動で処理されます。退出していない人が 1 人になったらその人の勝ちです。</dd>
      <dt>再戦</dt><dd>試合が終わったら「席に残る」で再戦を待てます。作成者が Rematch を押すと、残った人だけで同じ設定の新しい試合が始まります（人数は残った人数）。作成者が Menu に戻ったか、${REMATCH_HOST_WAIT_MS / 60000} 分たっても残らなければ、先に残った人が始められます。受付は終わってから ${REMATCH_MS / 60000} 分です。</dd>
      <dt>一時停止</dt><dd>残っている全員が離席中になると止まり、10 分誰も戻らなければ中止（pt なし）になります。</dd>
      <dt>ブラインド</dt><dd>BB がショートでオールインになっても、ほかに動ける人が 2 人以上いればコールする額は BB 満額です。</dd>
      <dt>記録</dt><dd>成績とハンド履歴はこの端末に保存されます（STATS → EXPORT で書き出せます）。途中で飛んだ試合も、順位と pt が決まった時点で STATS に入ります。</dd>
      <dt>スタッツ</dt><dd>STATS はゲームモードを選んで、そのモードの試合だけで数えます（累計 pt も生存ターンもモードをまたいで混ぜません）。VPIP はプリフロップで自分からチップを入れた（Call / Bet / Raise）ハンドの割合、PFR はプリフロップでレイズしたハンドの割合。生存ターン = ハンド数 ÷ VPIP(%) × 100 ÷ 試合数。</dd>
      <dt>プレイヤー</dt><dd>卓で席を押すと、その人のその卓のモードでのスタッツ（この端末に残っている、一緒に打って終わった試合から数えます）と、この試合の分が出ます。相手にはメモと色の印を付けられ、印の色は席のプレートに出ます。名前ごとにこの端末に保存し、EXPORT に含みます。</dd>
      <dt>ハンド履歴</dt><dd>STACK・NET・POT の単位は BB。Bet / Raise / All-in の数字はそのストリートの合計額、Call は払った額（チップ）。Uncalled はコールされずに戻ったチップです。</dd>
    </dl>
    <h3>ゲームモード <span>順位 → PT（人数ぶんの先頭を使う）</span></h3>
    <table class="tbl"><thead><tr><th>MODE</th>${[1, 2, 3, 4, 5, 6].map(i => `<th>${i}位</th>`).join('')}</tr></thead><tbody>${modes}</tbody></table>
    <h3>ブラインド構造 <span>SB/BB (ANTE)</span></h3>
    <div class="seg" id="rulesSeg">${SPEEDS.map(s => `<button type="button" data-s="${s}" aria-pressed="${tab === s}">${SPEED_LABEL[s]}</button>`).join('')}</div>
    <div class="blinds">${blinds}</div>`;
  $('#rulesSeg').onclick = e => { const b = e.target.closest('[data-s]'); if (b) { tab = b.dataset.s; paint(); } };
}
