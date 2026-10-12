// ルールのモーダル：進行・持ち時間・ブラインド構造（3 種）・ゲームモードの pt。説明は画面に出さずここに集める。
import { BLIND_TABLES, SPEED_LABEL, SPEEDS, MODE_IDS, modeLabel, payoutsFor, PLAYER_COUNTS, START_BBS, BASE_BB, LEVEL_MS, REMATCH_MS, REMATCH_HOST_WAIT_MS } from '../structure.js';
import { $, head, openDlg, fmt, fmtPt } from './util.js';

let tab = 'normal', seats = 6;
const segBtn = (attr, v, on, label) => '<button type="button" data-' + attr + '="' + v + '" aria-pressed="' + on + '">' + label + '</button>';
export function openRules() { paint(); openDlg('#rulesDlg'); }
// 選び直したときは、読んでいた位置を保って描き直す
function repaint() {
  const box = $('#rulesBody'), at = box.scrollTop;
  paint(); box.scrollTop = at;
}
function paint() {
  const t = BLIND_TABLES[tab];
  const blinds = t.map(([bb, ante], i) => `<span><i>${i + 1}</i>${fmt(bb / 2)}/${fmt(bb)} (${fmt(ante)})</span>`).join('');
  const places = Array.from({ length: seats }, (_, i) => i + 1);
  const modes = MODE_IDS.map(m => '<tr><td>' + modeLabel(m) + '</td>' + payoutsFor({ mode: m, players: seats }).map(v => '<td>' + fmtPt(v) + '</td>').join('') + '</tr>').join('');
  $('#rulesBody').innerHTML = head('RULES', 'ルール') + `
    <h3>進行 <span>NO-LIMIT HOLD'EM ・ SIT &amp; GO</span></h3>
    <dl class="spec">
      <dt>部屋</dt><dd>PRIVATE MATCH は部屋番号か招待 URL で入れる部屋、FREE MATCH は一覧に公開されて誰でも入れる部屋、FRIEND MATCH は専用の Discord サーバーのメンバーだけが入れる部屋です。作成者が決めた人数（${PLAYER_COUNTS.join('/')}人）が揃った瞬間に始まります。募集は 15 分で締め切られます。</dd>
      <dt>設定</dt><dd>ポーカーチェイスの SIT &amp; GO と同じです。初期チップ ${START_BBS.map(b => (b * BASE_BB).toLocaleString('en-US')).join('/')} 枚（${START_BBS.join('/')} BB。レベル 1 の BB = ${BASE_BB} 枚）、ブラインド構造 3 種。アンティは全員が払います。</dd>
      <dt>レベル</dt><dd>${LEVEL_MS / 60000} 分ごとに上がります。${LEVEL_MS / 60000} 分たつとタイマーが止まり、次のハンドから上のレベルになって、そこからまた数えます。</dd>
      <dt>ボタン</dt><dd>デッドボタン方式。ヘッズアップではボタンが SB です。</dd>
      <dt>持ち時間</dt><dd>1 アクション 15 秒。切れるとタイムバンク（1 試合 30 秒）を使います。尽きるとチェックかフォールドになり、2 回続くと離席扱いになります（I'm back で戻れます）。</dd>
      <dt>ショーダウン</dt><dd>残った全員が表向きにします。オールインで残りのボードを配るときは、手札と勝率を見せてから 1 枚ずつ開き（リバーは勝負が残っていれば伏せて置いてからめくります）、次のハンドはその分だけ待ちます。</dd>
      <dt>ベットサイズ</dt><dd>Bet / Raise のシートに並ぶ候補は SETTINGS（ヘッダの歯車）で変えられます（この端末に保存）。BB は BB の何倍まで、x は直前のベット/レイズの何倍まで、% はポットの何 %（ベットを受けているときは、コールした後のポットの何 % を足すか）です。Min と All-in はいつも出ます。スライダーの刻みも選べます。</dd>
      <dt>演出 GIF</dt><dd>PRIVATE MATCH と FRIEND MATCH だけ。SETTINGS の「演出 GIF」で選んでおくと、ショーダウンで勝ったとき（チョップを除く）に、勝負が決まってから卓の中央に出て全員に見えます。次のハンドはその分だけ待ちます。選ばなくても遊べます。部屋には GIF の番号だけを送ります。試合の途中で変えてもすぐ反映されます。GIF は KLIPY が提供するもので、表示するためにブラウザが KLIPY（api.klipy.com・static.klipy.com）に直接つなぎます。</dd>
      <dt>表示</dt><dd>卓のベット・ポット・Call / Raise の額は BB で表示します。席のスタックは BB かチップ数で、スタックを押すと切り替わります。</dd>
      <dt>退出</dt><dd>途中で退出すると戻れません。チップは卓に残り自動で処理されます。退出していない人が 1 人になったらその人の勝ちです。</dd>
      <dt>再戦</dt><dd>試合が終わったら「席に残る」で再戦を待てます。作成者が Rematch を押すと、残った人だけで同じ設定の新しい試合が始まります（人数は残った人数）。作成者が Menu に戻ったか、${REMATCH_HOST_WAIT_MS / 60000} 分たっても残らなければ、先に残った人が始められます。受付は終わってから ${REMATCH_MS / 60000} 分です。</dd>
      <dt>一時停止</dt><dd>残っている全員が離席中になると止まり、10 分誰も戻らなければ中止（pt なし）になります。</dd>
      <dt>ブラインド</dt><dd>BB がショートでオールインになっても、ほかに動ける人が 2 人以上いればコールする額は BB 満額です。</dd>
      <dt>記録</dt><dd>成績とハンド履歴はこの端末に保存されます（STATS → EXPORT で書き出せます）。途中で飛んだ試合も、順位と pt が決まった時点で STATS に入ります。</dd>
      <dt>スタッツ</dt><dd>STATS はゲームモードを選んで、そのモードの試合だけで数えます（累計 pt も生存ターンもモードをまたいで混ぜません）。VPIP はプリフロップで自分からチップを入れた（Call / Bet / Raise）ハンドの割合、PFR はプリフロップでレイズしたハンドの割合。生存ターン = ハンド数 ÷ VPIP(%) × 100 ÷ 試合数。</dd>
      <dt>プレイヤー</dt><dd>卓で席（スタック以外）を押すと、その人のその卓のモードでのスタッツ（この端末に残っている、一緒に打って終わった試合から数えます）と、この試合の分が出ます。相手にはメモと色の印を付けられ、印の色は席のプレートに出ます。名前ごとにこの端末に保存し、EXPORT に含みます。</dd>
      <dt>FRIEND MATCH</dt><dd>はじめに Discord でメンバーの確認をします（30 日ごと）。Discord から受け取るのは、専用のサーバーのメンバーかどうかだけです。Discord の ID や名前は保存せず、同じアカウントを見分けるための照合用の値（元に戻せないハッシュ）だけを残します。部屋は PRIVATE MATCH と同じで、部屋番号か招待 URL で集まり、チャットと演出 GIF も使えます。試合が終わると、順位・pt とハンドの集計（ハンド数・VPIP・PFR の回数）がサーバーに残り、メンバー全員の STATS と RANKING に出ます。</dd>
      <dt>FRIEND STATS</dt><dd>ゲームモードごとに数えます（モードをまたいで混ぜません）。シーズンは日本時間の暦月で、通算も選べます。平均 = 合計 pt ÷ 参加数、加点率 = pt が + になった試合の割合、1位率 = 1 位の割合、平均順位 = 順位の平均、生存T = 生存ターン（ハンド数 ÷ VPIP(%) × 100 ÷ 参加数）。グラフの色の線は強調した人（下のチップで 6 人まで。色は人ごとに決まり、選び直しても変わりません）、破線はメンバー平均です。表の見出しを押すと並べ替え、行を押すとその人の詳細が開きます。RANKING は合計 pt の多い順（同じなら平均 pt の高い方、次に参加の多い方）です。</dd>
      <dt>ハンド履歴</dt><dd>STACK・NET・POT の単位は BB。Bet / Raise / All-in の数字はそのストリートの合計額、Call は払った額（チップ）。Uncalled はコールされずに戻ったチップです。</dd>
    </dl>
    <h3>ゲームモード <span>順位 → PT</span></h3>
    <dl class="spec">
      <dt>人数と PT</dt><dd>6 人卓の表がもとです。少ない人数の卓は、その表を人数ぶんに等分して、順位ごとにその範囲の平均を使います（2 人なら 1 位は 6 人卓の 1〜3 位の平均、2 位は 4〜6 位の平均）。どの人数で打っても 1 人あたりの平均 PT は同じです。</dd>
    </dl>
    <div class="seg" id="rulesSeats">${PLAYER_COUNTS.map(n => segBtn('n', n, seats === n, n + '人')).join('')}</div>
    <table class="tbl"><thead><tr><th>MODE</th>${places.map(i => '<th>' + i + '位</th>').join('')}</tr></thead><tbody>${modes}</tbody></table>
    <h3>ブラインド構造 <span>SB/BB (ANTE)</span></h3>
    <div class="seg" id="rulesSeg">${SPEEDS.map(s => segBtn('s', s, tab === s, SPEED_LABEL[s])).join('')}</div>
    <div class="blinds">${blinds}</div>`;
  $('#rulesSeg').onclick = e => { const b = e.target.closest('[data-s]'); if (b) { tab = b.dataset.s; repaint(); } };
  $('#rulesSeats').onclick = e => { const b = e.target.closest('[data-n]'); if (b) { seats = +b.dataset.n; repaint(); } };
}
