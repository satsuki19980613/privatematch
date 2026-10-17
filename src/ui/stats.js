// STATS（pocket-ICM のスタッツ画面と同じ骨組み）：ゲームモードを選び、そのモードだけで試合数・平均順位・1位率・入賞率・累計 pt・直近の成績、
// HANDS・VPIP・PFR・生存ターン、順位分布、累計 pt のグラフと期間。HAND HISTORY（試合ごとの一覧 → ハンドの詳細）。
// FRIEND MATCH の試合は数えない（FRIEND MATCH の STATS が受け持つ。HAND HISTORY には並べる）。
// 卓の人数（すべて / 2〜6 人）でも絞る。順位（平均順位・1位率・順位分布）は人数を選んだときだけ並べ、すべてのときは人数ごとの順位の表にする。
// データはすべてこの端末の IndexedDB（history/store.js）。プレイヤーのメモ（history/notes.js）も EXPORT / IMPORT に含める。
import { configSummary, MODE_IDS } from '../structure.js';
import { $, app, esc, fmt, head, openDlg, toast, cardHTML, cardText, fmtPt, fmtBb, localGet, localSet, kindShort, statTile } from './util.js';
import { paint, setPane } from './menu.js';
import { modeSegHTML, bindModeSeg } from './modeseg.js';
import { seatsSegHTML, bindSeatsSeg, placeTableHTML } from './seats.js';
import * as store from '../history/store.js';
import { syncRoom } from '../history/sync.js';
import { PERIODS, finishedGames, filterByPeriod, cumulativePt, recentPlaces, summarize, pctLabel, handStats, niceTicks, byMode, byScope, latestMode, gameHandStats, mergeStats,
  ALL, parseSeats, seatsLabel, seatsOfGames, bySeats, placeRowsOf } from '../history/stats.js';
import { allNotes, importNotes } from '../history/notes.js';
import { netOfRecord, positionsOf, streetPots, STREET_NAMES, actionText, forcedOf } from '../history/hand.js';

const MODE_KEY = 'pm-stats-mode', SEATS_KEY = 'pm-stats-seats';
// mine: roomId → その試合の自分のハンド集計（全ハンドは持ち続けない）。seats: 卓の人数（ALL = すべて）
let games = null, mine = new Map(), loading = false, period = 'all', mode = null, seats = ALL, openGame = null, handsCache = new Map(), hover = null;
const PAGE = 30;
let shown = PAGE;

async function load() {
  if (loading) { return; } loading = true;
  try {
    games = await store.allGames();
    // まだ「途中」の試合（退出した・飛んだあと閉じた）は、サーバーに残っている間に結果を取りに行く
    const open = app.user ? games.filter(g => g.status === 'running' && (g.startedAt ?? 0) > Date.now() - 3 * 86_400_000) : [];
    if (open.length && (await Promise.all(open.map(g => syncRoom(g.roomId)))).some(Boolean)) games = await store.allGames();
    const hands = await store.handsByRoom();
    mine = new Map(games.map(g => [g.roomId, gameHandStats(hands.get(g.roomId), g.seat)]));
  }
  catch { games = games || []; toast('この端末では記録を読み書きできません'); }
  // 選んだモード（選んだことが無ければ最後に終わった試合のモード。知らない値は使わない）
  const m = localGet(MODE_KEY);
  mode = MODE_IDS.includes(m) ? m : latestMode(byScope(games, false), MODE_IDS);
  seats = parseSeats(localGet(SEATS_KEY));
  loading = false;
  renderNow();
}
const renderNow = () => { const el = $('#menuIn'); if (el && (pane0 === 'stats' || pane0 === 'history')) render(el, pane0, true); };
let pane0 = 'stats';
/** 記録が増えたら読み直す（卓から戻ったときなど） */
export function invalidate() { games = null; mine = new Map(); handsCache.clear(); }

export function render(el, pane, fromLoad) {
  pane0 = pane;
  if (games === null) { if (!fromLoad) { void load(); } return paint(el, '<div class="empty-note"><span class="dots" style="justify-content:center"><i></i><i></i><i></i></span></div>'); }
  if (pane === 'history') return paint(el, historyHTML(), bindHistory);
  paint(el, statsHTML(), bindStats);
}

/* ===================== STATS ===================== */
const PLACE_LABEL = ['1位', '2位', '3位', '4位', '5位', '6位'];
const stat = statTile;
const fmtDate = ms => { const d = new Date(ms); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`; };

/** 集計する試合（FRIEND MATCH を除いた、終わった試合） */
const statGames = () => byScope(finishedGames(games), false);
/** 選んだモードの試合と、表示する卓の人数（選んだ人数の試合がそのモードに無ければ、すべて） */
function modeGames() {
  const inMode = byMode(statGames(), mode), list = seatsOfGames(inMode);
  return { inMode, list, cur: list.includes(seats) ? seats : ALL };
}
/** 選んだモード・人数で、期間で絞った試合 */
const pickedGames = () => { const m = modeGames(); return filterByPeriod(bySeats(m.inMode, m.cur), period); };

const toneOf = v => { if (v > 0) { return 'gain'; } return v < 0 ? 'loss' : ''; };
// 直近の成績。すべての卓では「順位/人数」（人数の違う順位を並べるので）
function recentHTML(all, cur) {
  if (cur !== ALL) { const r = recentPlaces(all, 10); return r.length ? esc(r.join(' ')) : '–'; }
  const r = all.slice(-10).map(g => `<span class="rp">${esc(g.place)}<small>/${esc(g.config.players)}</small></span>`);
  return r.length ? r.join(' ') : '–';
}
// 2 つ目と 3 つ目の数字：人数を選んだら平均順位と 1位率、すべての卓では平均 pt と平均の人数
function placeTiles(sum, picked, cur) {
  if (cur !== ALL) return stat('平均順位', sum.games ? sum.avgPlace.toFixed(2) : '–', '位') + stat('1位率', pctLabel(sum.firstRate), '%');
  const avgPt = sum.games ? fmtPt(sum.totalPt / sum.games) : '–', avgSeats = sum.games ? (picked.reduce((a, g) => a + g.config.players, 0) / sum.games).toFixed(1) : '–';
  return stat('平均pt', avgPt, 'pt') + stat('平均人数', avgSeats, '人');
}
// 順位分布：人数を選んだらその人数までの棒、すべての卓では人数ごとの表
function distHTML(sum, picked, cur) {
  if (cur === ALL) return placeTableHTML(placeRowsOf(picked));
  const rows = sum.placeDist.slice(0, cur), max = Math.max(1, ...rows);
  const row = (c, i) => `<div class="spd-row"><span class="spd-label">${PLACE_LABEL[i]}</span><span class="spd-bar"><span class="${i === 0 ? 'spd-fill first' : 'spd-fill'}" style="width:${(c / max) * 100}%"></span></span><span class="spd-count">${c}</span></div>`;
  return `<div class="spd">${rows.map(row).join('')}</div>`;
}

function statsHTML() {
  const own = statGames(), total = own.length, { inMode, list, cur } = modeGames(), all = bySeats(inMode, cur), picked = filterByPeriod(all, period);
  const sum = summarize(picked), pts = cumulativePt(picked), ps = mergeStats(picked.map(g => mine.get(g.roomId)));
  return `<button class="back" data-back type="button">← BACK</button>
    <div class="panel hs-panel">
      <div class="hs-head"><span class="hs-title">STATS</span><span class="hs-total">全モード <b>${total.toLocaleString()}</b></span></div>
      <button class="btn ghost wide hs-history-btn" id="histBtn" type="button">HAND HISTORY</button>
      <div class="hs-modes">${modeSegHTML(mode)}${seatsSegHTML(list, cur)}</div>
      <div class="hs-first"><span>First Play</span><b>${all.length ? fmtDate(all[0].endedAt) : '–'}</b></div>
      <div class="hs-grid">
        ${stat('試合数', sum.games.toLocaleString())}
        ${placeTiles(sum, picked, cur)}
        ${stat('入賞率', pctLabel(sum.cashRate), '%', '(pt &gt; 0)')}
        ${stat('累計pt', fmtPt(sum.totalPt), 'pt', '', toneOf(sum.totalPt))}
        ${stat('直近の成績', recentHTML(all, cur), '', all.length ? '古い→新しい' : '')}
      </div>
      <div class="hs-grid4">
        ${stat('HANDS', ps.hands.toLocaleString())}
        ${stat('VPIP', pctLabel(ps.vpip), '%')}
        ${stat('PFR', pctLabel(ps.pfr), '%')}
        ${stat('生存ターン', ps.survival == null ? '–' : ps.survival.toFixed(1))}
      </div>
    </div>
    <div class="panel hs-panel"><div class="hs-head"><span class="hs-title">順位分布</span><span class="hs-total">${cur === ALL ? '人数別' : esc(seatsLabel(cur)) + 'の卓'}</span></div>${distHTML(sum, picked, cur)}</div>
    <div class="panel hs-panel">
      ${chartHTML(pts)}
      <div class="hs-period"><span class="hs-period-lbl">期間</span><div class="seg">${PERIODS.map(p => `<button type="button" data-p="${p.key}" aria-pressed="${period === p.key}">${p.label}</button>`).join('')}</div></div>
    </div>
    <div class="io"><button class="back" id="expBtn" type="button">EXPORT</button><label class="back" for="impIn">IMPORT</label><input id="impIn" type="file" accept="application/json" hidden></div>`;
}

const CW = 360, CH = 180, CPL = 40, CPR = 10, CPT = 10, CPB = 22, CPW = CW - CPL - CPR, CPH = CH - CPT - CPB;
function geo(points) {
  const n = points.length;
  let min = 0, max = 0; for (const p of points) { min = Math.min(min, p.y); max = Math.max(max, p.y); }
  if (max - min < 2) { max += 1; min -= 1; }
  const ticks = niceTicks(min, max), lo = Math.min(min, ticks[0] ?? min), hi = Math.max(max, ticks.at(-1) ?? max);
  const x = i => CPL + (n <= 1 ? CPW / 2 : (i / (n - 1)) * CPW), y = v => CPT + ((hi - v) / (hi - lo || 1)) * CPH;
  return { n, ticks, x, y };
}
function chartHTML(points) {
  const g = geo(points), n = g.n;
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${g.x(i).toFixed(1)} ${g.y(p.y).toFixed(1)}`).join(' ');
  const xt = []; if (n) { const c = Math.min(5, n); for (let k = 0; k < c; k++) xt.push(Math.round((k * (n - 1)) / Math.max(1, c - 1))); }
  return `<div class="hc"><div class="hc-read" id="hcRead"></div>
    <svg class="hc-svg" id="hcSvg" viewBox="0 0 ${CW} ${CH}" role="img" aria-label="累計 pt のグラフ">
      ${g.ticks.map(t => `<line class="hc-grid${t === 0 ? ' zero' : ''}" x1="${CPL}" x2="${CW - CPR}" y1="${g.y(t)}" y2="${g.y(t)}"/><text class="hc-ylbl" x="${CPL - 5}" y="${g.y(t) + 3}">${t}</text>`).join('')}
      ${xt.map((i, k) => `<text class="hc-xlbl" x="${g.x(i)}" y="${CH - 6}" text-anchor="${k === 0 ? 'start' : k === xt.length - 1 ? 'end' : 'middle'}">${i + 1}</text>`).join('')}
      ${n ? `<path class="hc-line" d="${path}"/>` : ''}${n === 1 ? `<circle class="hc-dot" cx="${g.x(0)}" cy="${g.y(points[0].y)}" r="3"/>` : ''}
      <g id="hcCur"></g>
      ${n ? '' : `<text class="hc-empty" x="${CW / 2}" y="${CH / 2}" text-anchor="middle">NO DATA</text>`}
    </svg></div>`;
}
function bindStats(el) {
  el.querySelector('[data-back]').onclick = () => setPane('main');
  el.querySelector('#histBtn').onclick = () => { openGame = null; shown = PAGE; setPane('history'); };
  el.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { period = b.dataset.p; render(el, 'stats'); });
  bindModeSeg(el, () => mode, m => { mode = m; localSet(MODE_KEY, mode); render(el, 'stats'); });
  bindSeatsSeg(el, p => { seats = p; localSet(SEATS_KEY, String(p)); render(el, 'stats'); });
  const svg = el.querySelector('#hcSvg'), pts = cumulativePt(pickedGames()), g = geo(pts);
  const move = e => {
    if (!g.n) return;
    const r = svg.getBoundingClientRect(), xr = ((e.clientX - r.left) / r.width) * CW;
    const i = Math.max(0, Math.min(g.n - 1, Math.round(g.n <= 1 ? 0 : ((xr - CPL) / CPW) * (g.n - 1))));
    el.querySelector('#hcCur').innerHTML = `<line class="hc-cursor" x1="${g.x(i)}" x2="${g.x(i)}" y1="${CPT}" y2="${CH - CPB}"/><circle class="hc-dot" cx="${g.x(i)}" cy="${g.y(pts[i].y)}" r="3.5"/>`;
    el.querySelector('#hcRead').innerHTML = `<span class="hc-read-v"><i></i>#${i + 1} ${fmtPt(pts[i].y)}pt</span>`;
  };
  svg.onpointermove = move; svg.onpointerdown = move;
  svg.onpointerleave = () => { el.querySelector('#hcCur').innerHTML = ''; el.querySelector('#hcRead').innerHTML = ''; };
  el.querySelector('#expBtn').onclick = async () => {
    try {
      const data = { ...(await store.exportAll()), notes: allNotes() };
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
      a.download = `privatematch-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch { toast('書き出せませんでした'); }
  };
  el.querySelector('#impIn').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text()), n = await store.importAll(data);
      if (data.notes) importNotes(data.notes);
      toast(`${n} 試合を読み込みました`); invalidate(); render(el, 'stats');
    }
    catch { toast('読み込めませんでした'); }
  };
}

/* ===================== HAND HISTORY ===================== */
const fmtTime = ms => { const d = new Date(ms), p = n => String(n).padStart(2, '0'); return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`; };
function historyHTML() {
  const list = games.slice().sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)).slice(0, shown);
  const rows = list.map(g => { try { return gameRow(g); } catch (e) { return ''; } }).join('');
  return `<button class="back" data-back type="button">← STATS</button>
    <div class="pane-h"><span class="eyebrow">HAND HISTORY</span></div>
    ${games.length ? `<ul class="hgames">${rows}</ul>${games.length > shown ? '<button class="btn ghost wide" id="moreBtn" type="button">もっと見る</button>' : ''}` : '<div class="empty-note">まだ記録がありません。</div>'}`;
}
// 1 試合の行（壊れた行が 1 つあっても一覧全体は出す）
function gameRow(g) {
    const open = openGame === g.roomId, hands = open ? handsCache.get(g.roomId) : null;
    const status = g.status === 'finished' ? `${esc(g.place ?? '–')}位 <b class="${(g.pt ?? 0) > 0 ? 'gain' : (g.pt ?? 0) < 0 ? 'loss' : ''}">${fmtPt(g.pt)} pt</b>` : g.status === 'cancelled' ? '中止' : '途中';
    let body = '';
    if (open) {
      if (!hands) body = '<div class="empty-note"><span class="dots" style="justify-content:center"><i></i><i></i><i></i></span></div>';
      else if (!hands.length) body = '<div class="empty-note">ハンドの記録がありません。</div>';
      else {
        const st = handStats(hands, () => g.seat);
        body = `<div class="hh-sum">VPIP <b>${pctLabel(st.vpip)}%</b> PFR <b>${pctLabel(st.pfr)}%</b> 収支 <b class="${st.netBb > 0 ? 'gain' : st.netBb < 0 ? 'loss' : ''}">${st.netBb > 0 ? '+' : ''}${st.netBb.toFixed(1)} BB</b></div>
          <ul class="hh-list">${hands.slice().reverse().map(h => {
            const net = netOfRecord(h, g.seat), pos = positionsOf(h)[g.seat];
            return `<li><button class="hh-row" type="button" data-hand="${h.handNo}"><span class="hh-no">#${h.handNo}</span><span class="hh-pos">${pos ?? '–'}</span>
              <span class="hh-cards">${h.hole ? h.hole.map(cardText).join('') : '<span class="ct">–</span>'}</span>
              <span class="hh-board">${h.board.map(cardText).join('')}</span>
              <span class="hh-net ${net > 0 ? 'gain' : net < 0 ? 'loss' : ''}">${net > 0 ? '+' : ''}${fmtBb(net, h.bb)}</span></button></li>`;
          }).join('')}</ul>`;
      }
    }
    return `<li class="hg${open ? ' open' : ''}"><button class="hg-head" type="button" data-game="${esc(g.roomId)}">
      <span class="hg-top"><span class="hg-date">${g.startedAt ? fmtTime(g.startedAt) : ''}</span><span class="hg-kind">${kindShort(g.kind)} #${esc(g.code)}</span><span class="hg-res">${status}</span></span>
      <span class="hg-cfg"><span class="hg-cfg-t">${esc(configSummary(g.config))}</span><span class="hg-cfg-n">・ ${+g.hands || 0} hands</span></span>
      <span class="hg-opp">${g.players.map((p, s) => s === g.seat ? '' : esc(p.name)).filter(Boolean).join(' / ')}</span></button>${body}</li>`;
}
function bindHistory(el) {
  el.querySelector('[data-back]').onclick = () => setPane('stats');
  const more = el.querySelector('#moreBtn'); if (more) more.onclick = () => { shown += PAGE; render(el, 'history'); };
  el.querySelectorAll('[data-game]').forEach(b => b.onclick = async () => {
    const id = b.dataset.game;
    openGame = openGame === id ? null : id; render(el, 'history');
    if (openGame && !handsCache.has(id)) {
      try { handsCache.set(id, await store.handsOf(id)); } catch (e) { handsCache.set(id, []); }
      if (openGame === id) render(el, 'history');
    }
  });
  el.querySelectorAll('[data-hand]').forEach(b => b.onclick = () => {
    const g = games.find(x => x.roomId === openGame), h = (handsCache.get(openGame) || []).find(x => x.handNo === +b.dataset.hand);
    if (g && h) openHand(g, h);
  });
}

/** ハンドの詳細：席・ポジション・開始スタック・手札、ストリートごとのボードとアクション、結果 */
export function openHand(g, h) {
  const pos = positionsOf(h), pots = streetPots(h), forced = forcedOf(h), n = h.startStacks.length, bb = h.bb;
  const name = s => (s === g.seat ? '<span class="me">YOU</span>' : esc(g.names[s] ?? `Seat ${s + 1}`));
  const players = Array.from({ length: n }, (_, s) => s).filter(s => h.startStacks[s] > 0).map(s => {
    const cards = s === g.seat ? h.hole : h.shown[s];
    const net = netOfRecord(h, s);
    return `<tr class="${s === g.seat ? 'me-row' : ''}"><td>${pos[s] ?? ''}</td><td class="nm2">${name(s)}</td><td>${fmtBb(h.startStacks[s], bb)}</td>
      <td class="hd-cards">${cards ? cards.map(c => cardHTML(c)).join('') : ''}</td><td class="${net > 0 ? 'gain' : net < 0 ? 'loss' : ''}">${net > 0 ? '+' : ''}${fmtBb(net, bb)}</td></tr>`;
  }).join('');
  const lastStreet = Math.max(0, ...h.actions.map(a => a.street), h.board.length >= 5 ? 3 : h.board.length >= 4 ? 2 : h.board.length >= 3 ? 1 : 0);
  const streets = [];
  for (let st = 0; st <= lastStreet; st++) {
    const acts = h.actions.filter(a => a.street === st);
    const board = st === 0 ? '' : h.board.slice(0, [0, 3, 4, 5][st]).map(c => cardHTML(c)).join('');
    // 実際に出したブラインド（ショートのときは足りない額。アンティの分は除く）
    const blind = s => forced[s] - Math.min(h.startStacks[s], h.ante);
    const posts = st === 0 ? `<li class="post">Ante ${fmt(h.ante)} ・ ${h.sbSeat != null ? `${name(h.sbSeat)} SB ${fmt(blind(h.sbSeat))} ・ ` : 'SB なし ・ '}${name(h.bbSeat)} BB ${fmt(blind(h.bbSeat))}</li>` : '';
    streets.push(`<div class="hd-street"><div class="hd-sh"><b>${STREET_NAMES[st]}</b><span>POT ${fmtBb(pots[st], bb)} BB</span></div>
      ${board ? `<div class="hd-board">${board}</div>` : ''}
      <ul class="hd-acts">${posts}${acts.map(a => `<li><span class="nm2">${name(a.seat)}</span><span class="pl k-${esc(a.kind)}">${esc(actionText(a))}</span>${a.auto ? '<small>auto</small>' : ''}</li>`).join('')}</ul></div>`);
  }
  const res = h.pots.map((p, i) => `<li>${p.eligible?.length === 1 && i > 0 ? 'Uncalled ' : h.pots.length > 1 ? (i === 0 ? 'Main' : 'Side') + ' ' : ''}${fmt(p.amount)} → ${p.winners.map(name).join(', ')}${p.winners.length === 1 && !(p.eligible?.length === 1 && i > 0) && h.names[p.winners[0]] ? ` <small>${esc(h.names[p.winners[0]])}</small>` : ''}</li>`).join('');
  $('#handBody').innerHTML = head(`HAND #${fmt(h.handNo)} ・ LV ${fmt(h.level)} ・ ${fmt(h.sb)}/${fmt(h.bb)} (${fmt(h.ante)})`, `${kindShort(g.kind)} #${esc(g.code)}`) +
    `<table class="tbl hd-tbl"><thead><tr><th>POS</th><th>NAME</th><th>STACK</th><th>CARDS</th><th>NET</th></tr></thead><tbody>${players}</tbody></table>
    ${streets.join('')}
    <div class="hd-sh"><b>Result</b></div><ul class="hd-acts">${res}</ul>
    ${h.eliminated.length ? `<p class="hint">${h.eliminated.map(e => `${name(e.seat)} ${+e.place || 0}位で脱落`).join(' ・ ')}</p>` : ''}`;
  openDlg('#handDlg');
}

/** 卓から戻ったときなどに呼ぶ */
export function refresh() { invalidate(); }
export { app };
