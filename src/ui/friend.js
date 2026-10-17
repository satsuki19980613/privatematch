// FRIEND MATCH の画面：入口（部屋を作る / 部屋番号で入る / STATS / RANKING）、Discord のメンバー確認、スタッツ、ランキング。
// 専用の Discord サーバーのメンバーだけが入れる（確認は Function "game" の discord_start / discord_link。server/game/discord.js）。
// 確認は 2 通り：Discord の同意の画面へ行く（OAuth2）か、出た番号を Discord のサーバーで /link 番号 と打つ（discord_code。Discord のアプリだけで済む）。
// スタッツとランキングはサーバーに残した FRIEND MATCH の結果から（RPC friend_stats。集計は src/friend.js）。
// 表示の項目と形は Kagaribi Stat Hub のスタッツビュー：シーズン内（累積 pt のグラフ・メンバー別の表）とシーズン推移（指標ごとのグラフと表）。
// ゲームモードをまたいで混ぜない。シーズンは日本時間の暦月。
// 卓の人数を選べる（すべて / 2〜6 人）。順位（平均順位・1 位率・順位の分布）は人数を選んだときだけ並べ、すべてのときは人数ごとの順位の表にする。
import { MODE_IDS, modeLabel } from '../structure.js';
import { $, app, esc, head, openDlg, toast, fmtPt, localGet, localSet, statTile, copyText, INVITE_KEY } from './util.js';
import { paint, setPane, currentPane } from './menu.js';
import { modeSegHTML, bindModeSeg } from './modeseg.js';
import { lineChartHTML, bindLineChart } from './linechart.js';
import {
  ALL, MAX_FOCUS, columnsFor, trendMetricsFor, seasonLabel, seasonShort, dayShort, memberRows, placeRows, totalOf, ranking, sortRows,
  cumulative, cumulativeSeasons, trend, toggleFocus, slotOf, parseFocus, fmtRate, fmtNum, dayOf, seatsOf, seatsLabel, parseSeats,
} from '../friend.js';

const MODE_KEY = 'pm-friend-mode', SEATS_KEY = 'pm-friend-seats', FOCUS_KEY = 'pm-friend-focus', RETRY_KEY = 'pm-discord';
const FRESH_MS = 30_000;   // 同じモード・シーズンを読み直すまでの間
const TOP = 5;             // スタッツの画面に出すランキングの人数
const DOTS = '<div class="empty-note"><span class="dots" style="justify-content:center"><i></i><i></i><i></i></span></div>';
const EMPTY = '<div class="empty-note">まだ記録がありません。</div>';
const backBtn = to => `<button class="back" data-back="${to}" type="button">← BACK</button>`;

// season: null = 最新のシーズン / ALL = 通算 / '2026-10'。seats: 卓の人数（ALL = すべて。null = まだ読んでいない）。sort.desc = 良い順
const S = { mode: null, season: null, seats: null, view: 'season', metric: 'pt', sort: { key: 'pt', desc: true }, data: null, loading: false, failed: false, gen: 0 };
const cache = new Map();   // `${mode}|${season}` → { at, data }
let focus = null;          // グラフで強調する人 [{ k, slot }]（null = まだ選んでいない：自分だけ）

/** その人が FRIEND MATCH に入れるか（Discord での確認が切れていない。サーバーも同じことを確かめる） */
export const isFriend = () => !!app.prof?.friend?.ok;

/* ===================== Discord のメンバー確認 ===================== */
const LINK_ERR = { not_member: 'Discord のメンバーではありません', friend_off: 'FRIEND MATCH は準備中です', too_many: '回数が多すぎます。しばらく待ってから' };
function sessionSet(k, v) { try { sessionStorage.setItem(k, v); } catch { /* プライベートモード */ } }
function sessionTake(k) {
  try { const v = sessionStorage.getItem(k); sessionStorage.removeItem(k); return v; } catch { return null; }
}

/** メニューの FRIEND MATCH：確認済みなら入口へ、まだなら Discord での確認へ */
let opening = false;
/** メニューの FRIEND MATCH。確認がまだなら、ほかの端末で済ませたばかりかもしれないので、読み直してから決める */
export async function openFriend() {
  if (isFriend()) return setPane('friend');
  if (opening) return;
  opening = true;
  try { await readMe(); } finally { opening = false; }
  if (isFriend()) setPane('friend'); else openGate();
}
// プロフィールを読み直す（確認できたかを見る）。読めなければ今のまま
async function readMe() {
  try { const p = await app.net.rpc('me'); if (p) app.prof = p; } catch { /* 次の機会に */ }
}

/* ---------- 確認のダイアログ ---------- */
// iPhone / iPad の Discord アプリは同意の画面（OAuth2）を受け取らないので、番号での確認を先に出す
const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const POLL_MS = 3000;              // 番号を出している間、確認できたかを見に行く間隔
const SNOWFLAKE = /^\d{5,25}$/;    // Discord のサーバーの ID
const gateBtn = (id, label, primary) => `<button class="${cls('btn', primary && 'primary')}" id="${id}" type="button">${label}</button>`;
let gate = null;                   // 番号を出している間の状態 { invite, until, poll, tick }

function stopGate() {
  if (!gate) return;
  clearInterval(gate.poll); clearInterval(gate.tick);
  document.removeEventListener('visibilitychange', checkGate);
  gate = null;
}
/** Discord での確認のダイアログ。invite = 確認のあとに入る部屋番号（招待 URL から来たとき） */
export function openGate(invite = null) {
  stopGate();
  const byCode = gateBtn('gateCode', '番号で確認', IOS), byPage = gateBtn('gateGo', 'Discord で確認', !IOS);
  $('#gateBody').innerHTML = head('FRIEND MATCH', 'Discord') + '<div class="btns">' + (IOS ? byCode + byPage : byPage + byCode) + '</div>';
  const dlg = $('#gateDlg');
  dlg.onclose = stopGate;
  openDlg('#gateDlg');
  const go = $('#gateGo'), code = $('#gateCode');
  const failed = e => { go.disabled = false; code.disabled = false; toast(LINK_ERR[e.code] || '確認を始められませんでした'); };
  go.onclick = async () => {
    go.disabled = true;
    try { await startDiscord(invite); } catch (e) { failed(e); }
  };
  code.onclick = async () => {
    code.disabled = true;
    try { showCode(await app.net.game({ op: 'discord_code' }), invite); } catch (e) { failed(e); }
  };
}
const leftText = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
// 番号を出す：Discord のサーバーで /link 番号 と打ってもらい、確認できるまで見に行く（期限が来たら最初の画面に戻す）
function showCode(r, invite) {
  const digits = String(r.code), open = SNOWFLAKE.test(r.guild ?? '') ? `<a class="btn primary" href="https://discord.com/channels/${r.guild}" target="_blank" rel="noopener">Discord を開く</a>` : '';
  $('#gateBody').innerHTML = head('FRIEND MATCH', 'Discord') + `
    <div class="gate-code"><span class="lbl">Discord のサーバーで送信</span>
      <div class="gate-cmd"><b>/link</b><span class="code-big" aria-label="番号">${esc(digits.replace(/(\d{3})(\d{3})/, '$1 $2'))}</span></div>
      <span class="gate-left" id="gateLeft">${leftText(r.until - Date.now())}</span></div>
    <div class="btns"><button class="btn ghost" id="gateCopy" type="button">Copy</button>${open}</div>`;
  $('#gateCopy').onclick = () => copyText(digits);
  stopGate();
  gate = { invite, until: r.until, poll: setInterval(checkGate, POLL_MS), tick: setInterval(tickGate, 1000) };
  document.addEventListener('visibilitychange', checkGate);   // Discord のアプリから戻ってきたら、すぐ見に行く
}
function tickGate() {
  if (!gate) return;
  const left = gate.until - Date.now(), el = $('#gateLeft');
  if (left <= 0) { const { invite } = gate; return openGate(invite); }
  if (el) el.textContent = leftText(left);
}
async function checkGate() {
  if (!gate || gate.busy || document.visibilityState !== 'visible') return;
  gate.busy = true;
  try { await readMe(); } finally { if (gate) gate.busy = false; }
  if (!gate || !isFriend()) return;
  const { invite } = gate;
  $('#gateDlg').close();   // onclose が見に行くのを止める
  toast('Discord のメンバーを確認しました');
  if (invite) sessionSet(INVITE_KEY, invite);
  await app.nav.refreshMe();   // 招待 URL から来ていれば、その部屋の確認が開く
  if (!invite && !app.prof?.room) setPane('friend');
}
// Discord の同意の画面へ（このページを離れる）。あとで入る部屋番号はセッションに預ける。
// 戻りを照合する state はサーバーが出し、戻ったときもサーバーが確かめる（server/game/discord.js）：
// Discord のアプリ内ブラウザから始めると、認可のあと別のブラウザへ戻ってくることがあり、このブラウザに預けた値では照合できないため
async function startDiscord(invite) {
  const r = await app.net.game({ op: 'discord_start' });
  if (invite) sessionSet(INVITE_KEY, invite);
  location.assign(r.url);
}
// Discord の戻りの形（code は 1 回限りの値、state はサーバーが出した '期限.署名'）
const RETURN_SHAPE = { code: /^[\w-]{8,128}$/, state: /^\d{10,16}\.[\w-]{20,64}$/ };
/**
 * 起動時：Discord から戻ってきた URL（?code=…&state=… / ?error=…&state=…）なら、その値を受け取って URL から消す。
 * => { code, state } | { error } | null
 */
export function takeReturn() {
  const u = new URL(location.href), state = u.searchParams.get('state');
  if (!state) return null;
  const code = u.searchParams.get('code'), error = u.searchParams.get('error');
  for (const k of ['code', 'state', 'error', 'error_description']) u.searchParams.delete(k);
  history.replaceState(null, '', u.pathname + u.search + u.hash);
  if (!RETURN_SHAPE.state.test(state)) return null;
  if (code && RETURN_SHAPE.code.test(code)) return { code, state };
  return error ? { error } : null;
}
/**
 * まだログインしていないブラウザに Discord から戻ってきた（Discord のアプリ内ブラウザから始めたときなど）：
 * ログインのあとで、このブラウザからもう一度確認してもらう。預けるのは印だけ（戻りの値は預けない）
 */
export function deferReturn(ret) { if (ret?.code) sessionSet(RETRY_KEY, '1'); }
/** ログインのあと：deferReturn の印があれば、確認のダイアログを出す（部屋に居る・もう確認済みなら出さない） */
export function resumeGate() {
  if (sessionTake(RETRY_KEY) === '1' && app.prof && !app.prof.room && !isFriend()) openGate();
}
/** takeReturn の値をサーバーで確かめる（ログイン済みのとき）。=> 確認できたか */
export async function finishReturn(ret) {
  if (!ret.code) { toast('Discord の確認を中止しました'); return false; }
  try { await app.net.game({ op: 'discord_link', code: ret.code, state: ret.state }); }
  catch (e) { toast(LINK_ERR[e.code] || 'Discord で確認できませんでした'); return false; }
  toast('Discord のメンバーを確認しました');
  return true;
}

/* ===================== 入口 ===================== */
function hubHTML() {
  return `${backBtn('main')}<div class="pane-h"><span class="eyebrow">FRIEND MATCH</span></div>
    <button class="mbtn" id="fmStart" type="button"><span>フレンドマッチを開始<small>部屋番号と招待 URL が発行されます</small></span><span class="rt">＋</span></button>
    <button class="mbtn" id="fmCode" type="button"><span>部屋番号で入る<small>6 桁の番号を入力</small></span><span class="rt">#</span></button>
    <button class="mbtn" id="fmStats" type="button"><span>STATS<small>メンバーの成績</small></span></button>
    <button class="mbtn" id="fmRank" type="button"><span>RANKING<small>ゲームモードごとの順位</small></span></button>`;
}
function bindBack(el) { el.querySelectorAll('[data-back]').forEach(b => b.onclick = () => setPane(b.dataset.back)); }
function bindHub(el) {
  bindBack(el);
  el.querySelector('#fmStart').onclick = () => setPane('create', { kind: 'friend' });
  el.querySelector('#fmCode').onclick = () => setPane('join', { from: 'friend' });
  el.querySelector('#fmStats').onclick = () => openPane('fstats');
  el.querySelector('#fmRank').onclick = () => openPane('frank');
}

/* ===================== データ ===================== */
const cacheKey = () => `${S.mode}|${S.season ?? ''}`;
const shown = () => ['fstats', 'frank'].includes(currentPane());
function rerender() { const el = $('#menuIn'); if (el && shown()) render(el, currentPane()); }
function openPane(pane) {
  S.failed = false;
  setPane(pane);
  refresh();
}
// いまのモード・シーズンを読む（読んだばかりならそれを使う）
function refresh() {
  if (!S.mode) S.mode = MODE_IDS.includes(localGet(MODE_KEY)) ? localGet(MODE_KEY) : 'club';
  if (S.seats == null) S.seats = parseSeats(localGet(SEATS_KEY));
  const hit = cache.get(cacheKey());
  if (hit && Date.now() - hit.at < FRESH_MS) { S.data = hit.data; S.failed = false; S.gen++; S.loading = false; return rerender(); }
  S.data = null;
  void load();   // 読み込み中の印（S.loading）を先に立ててから描く
  rerender();
}
async function load() {
  const gen = ++S.gen, key = cacheKey();
  S.loading = true; S.failed = false;
  try {
    const data = await app.net.rpc('friend_stats', { p_mode: S.mode, p_season: S.season === ALL ? null : S.season });
    if (gen !== S.gen) return;
    cache.set(key, { at: Date.now(), data });
    S.data = data; S.loading = false;
  } catch (e) {
    if (gen !== S.gen) return;
    S.loading = false; S.failed = true;
    if (e.code === 'not_friend') return lostAccess();
    toast('読み込めませんでした');
  }
  rerender();
}
// 確認が切れていた（30 日）・Discord のサーバーを抜けた：メニューへ戻して、もう一度確かめてもらう
async function lostAccess() {
  await app.nav.refreshMe();
  if (shown() || currentPane() === 'friend') setPane('main');
  openGate();
}
/** 部屋を出たあとなどに呼ぶ（次に開いたとき読み直す） */
export function invalidate() { cache.clear(); S.data = null; S.gen++; S.loading = false; }

// 表示するシーズン（通算か、サーバーが選んだシーズン）
const seasonOf = d => (S.season === ALL ? ALL : d.season);
// 表示する卓の人数（選んだ人数の記録がそのモードに無ければ、すべて）
const seatsIn = d => (d && seatsOf(d).includes(S.seats) ? S.seats : ALL);
const toneOf = v => { if (v > 0) { return 'gain'; } return v < 0 ? 'loss' : ''; };
const getFocus = d => focus ?? (d.me ? [{ k: d.me, slot: 0 }] : []);
function loadFocus() { const raw = localGet(FOCUS_KEY); if (raw != null && focus == null) focus = parseFocus(raw); }

/* ===================== 画面 ===================== */
export function render(el, pane) {
  if (pane === 'friend') return paint(el, hubHTML(), bindHub);
  if (!S.data && !S.loading && !S.failed) { loadFocus(); return refresh(); }
  loadFocus();
  if (pane === 'frank') return paint(el, rankPaneHTML(), bindRankPane);
  paint(el, statsPaneHTML(), bindStatsPane);
}

/* ---------- HTML の部品 ---------- */
const cls = (...names) => names.filter(Boolean).join(' ');
const slotCls = slot => (slot == null ? '' : 's' + (slot + 1));
const td = html => '<td>' + html + '</td>';
const th = html => '<th>' + html + '</th>';
const optionHTML = (value, label, picked) => `<option value="${esc(value)}"${picked ? ' selected' : ''}>${esc(label)}</option>`;
const selectHTML = (id, label, options, enabled = true) => `<select class="tin fr-sel" id="${id}" aria-label="${label}"${enabled ? '' : ' disabled'}>${options}</select>`;
const nameCell = (name, slot) => `<span class="${cls('nmcell', slotCls(slot))}"><i class="key"></i>${esc(name)}</span>`;
const AVG_CELL = '<td><span class="nmcell legend-avg"><i class="key"></i>メンバー平均</span></td>';
// 表の 1 行（押すとその人の詳細）。cells = 名前の後ろの列
const memberTr = (m, me, slot, cells) => `<tr class="${cls('clk', me && 'me-row')}" data-member="${esc(m.k)}"><td>${nameCell(m.name, slot)}</td>${cells}</tr>`;
// 指標の列（メンバー別の表と、詳細のシーズン別で同じ並び。cols = columnsFor の値）
const CELL = {
  avg: r => fmtNum(r.avg), plusRate: r => fmtRate(r.plusRate), firstRate: r => fmtRate(r.firstRate),
  avgPlace: r => fmtNum(r.avgPlace), n: r => String(r.n), survival: r => fmtNum(r.survival, 1),
};
const metricCells = (r, cols) => cols.map(c => (c.key === 'pt' ? `<td class="${toneOf(r.pt)}">${fmtPt(r.pt)}</td>` : td(CELL[c.key](r)))).join('');
// 卓の人数の選択（そのモードで打たれた人数だけ）
const seatsBtnHTML = (p, cur) => `<button type="button" data-seats="${p}" aria-pressed="${cur === p}">${seatsLabel(p)}</button>`;
function seatsSegHTML(d) {
  const list = d ? seatsOf(d) : [], cur = seatsIn(d);
  if (!list.length) return '';
  const btns = [ALL, ...list].map(p => seatsBtnHTML(p, cur)).join('');
  return `<div class="seg fr-seats" role="group" aria-label="卓の人数">${btns}</div>`;
}
// 人数ごとの順位の表（行 = 卓の人数。色の濃さはその人数での割合）。hi = 強調する人数
function placeTableHTML(list, hi = ALL) {
  if (!list.length) return EMPTY;
  const places = Array.from({ length: Math.max(...list.map(r => r.p)) }, (_, i) => i);
  const cell = (r, i) => (i < r.p ? `<td class="pm-c" style="--h:${(r.dist[i] / r.n).toFixed(3)}">${r.dist[i]}</td>` : '<td></td>');
  const row = r => `<tr${r.p === hi ? ' class="hi"' : ''}>${td(seatsLabel(r.p))}${td(String(r.n))}${places.map(i => cell(r, i)).join('')}${td(fmtNum(r.avgPlace))}${td(fmtRate(r.firstRate))}</tr>`;
  return tableWrap(th('人数') + th('戦') + places.map(i => `<th class="pm-h">${i + 1}位</th>`).join('') + th('平均') + th('1位率'), list.map(row).join(''), 'pm-tbl');
}
const tableWrap = (headCells, bodyRows, extra = '') => `<div class="tbl-scroll"><table class="${cls('tbl fr-tbl', extra)}"><thead><tr>${headCells}</tr></thead><tbody>${bodyRows}</tbody></table></div>`;

function seasonSelHTML(d) {
  // 新しいシーズンが上、通算はいちばん下
  const picked = d ? seasonOf(d) : S.season ?? '', ordered = [...(d?.seasons ?? [])].reverse().concat(ALL);
  return selectHTML('seasonSel', 'シーズン', ordered.map(s => optionHTML(s, seasonLabel(s), s === picked)).join(''), !!d);
}
function bindCommon(el) {
  bindBack(el);
  bindModeSeg(el, () => S.mode, m => { S.mode = m; localSet(MODE_KEY, m); S.season = S.season === ALL ? ALL : null; refresh(); });
  el.querySelectorAll('[data-seats]').forEach(b => b.onclick = () => { S.seats = parseSeats(b.dataset.seats); localSet(SEATS_KEY, String(S.seats)); rerender(); });
  const sel = el.querySelector('#seasonSel');
  if (sel) sel.onchange = () => { S.season = sel.value; refresh(); };
  el.querySelectorAll('[data-member]').forEach(b => b.onclick = () => openMember(b.dataset.member));
}
const bodyWait = () => (S.failed ? '<div class="empty-note">読み込めませんでした。</div>' : DOTS);

/* ---------- ランキング ---------- */
// 順位の指標は人数を選んだときだけ（人数の違う卓の順位は比べられない）
const rankMeta = (r, seats) => (seats === ALL
  ? `${r.n}戦 ・ 平均 ${fmtNum(r.avg)} ・ 加点率 ${fmtRate(r.plusRate)}`
  : `${r.n}戦 ・ 平均 ${fmtNum(r.avg)} ・ 1位 ${fmtRate(r.firstRate)} ・ 順位 ${fmtNum(r.avgPlace)}`);
const rankRowHTML = (r, seats) => `<li><button class="${cls('rk-row', r.me && 'me-row', r.rank <= 3 && 'top')}" type="button" data-member="${esc(r.k)}">
    <span class="rk-no">${r.rank}</span><span class="rk-name">${esc(r.name)}${r.me ? ' <em>YOU</em>' : ''}</span>
    <b class="rk-pt ${toneOf(r.pt)}">${fmtPt(r.pt)}<small>pt</small></b>
    <span class="rk-meta">${rankMeta(r, seats)}</span></button></li>`;
function rankListHTML(list, seats) {
  if (!list.length) return EMPTY;
  return '<ol class="rk">' + list.map(r => rankRowHTML(r, seats)).join('') + '</ol>';
}
function rankPaneHTML() {
  const d = S.data, seats = seatsIn(d);
  return `${backBtn('friend')}
    <div class="panel hs-panel fr-panel">
      <div class="hs-head"><span class="hs-title">RANKING</span><span class="hs-total">${esc(modeLabel(S.mode))}</span></div>
      <div class="hs-modes">${modeSegHTML(S.mode)}</div>
      ${seasonSelHTML(d)}${seatsSegHTML(d)}
      ${d ? rankListHTML(ranking(memberRows(d, seasonOf(d), seats)), seats) : bodyWait()}
    </div>`;
}
function bindRankPane(el) { bindCommon(el); }

/* ---------- スタッツ ---------- */
const VIEWS = [['season', 'シーズン内'], ['trend', 'シーズン推移']];
const viewBtnHTML = ([v, label]) => `<button type="button" data-view="${v}" aria-pressed="${S.view === v}">${label}</button>`;
const metricSelHTML = d => { const m = metricOf(seatsIn(d)); return selectHTML('metricSel', '指標', trendMetricsFor(seatsIn(d)).map(x => optionHTML(x.key, x.label, x.key === m.key)).join('')); };
function statsBodyHTML(d) {
  if (!d) return bodyWait();
  return S.view === 'season' ? seasonViewHTML(d) : trendViewHTML(d);
}
function statsPaneHTML() {
  const d = S.data;
  return `${backBtn('friend')}
    <div class="panel hs-panel fr-panel">
      <div class="hs-head"><span class="hs-title">FRIEND STATS</span><span class="hs-total">${esc(modeLabel(S.mode))}</span></div>
      <div class="hs-modes">${modeSegHTML(S.mode)}</div>
      <div class="seg fr-view">${VIEWS.map(viewBtnHTML).join('')}</div>
      ${S.view === 'season' ? seasonSelHTML(d) : metricSelHTML(d)}${seatsSegHTML(d)}
    </div>${statsBodyHTML(d)}`;
}

// グラフの下のチップ（強調する人を選ぶ。グラフの凡例を兼ねる）
function chipHTML(m, fc) {
  const slot = slotOf(fc, m.k), off = slot == null && fc.length >= MAX_FOCUS;
  return `<button type="button" class="${cls('chip', slot != null && 'on', slotCls(slot))}" data-chip="${esc(m.k)}" aria-pressed="${slot != null}"${off ? ' disabled' : ''}><i class="key"></i>${esc(m.name)}</button>`;
}
function chipsHTML(members, fc) {
  return `<div class="chips" role="group" aria-label="グラフで強調するメンバー"><span class="chip legend-avg"><i class="key"></i>平均</span>${members.map(m => chipHTML(m, fc)).join('')}</div>
    <div class="chips-foot"><span>強調 ${fc.length} / ${MAX_FOCUS}</span>${fc.length ? '<button type="button" class="back" id="chipClear">すべて解除</button>' : ''}</div>`;
}
// 強調した人の線（そのグラフに値のある人だけ）
function focusSeries(d, fc, series) {
  const names = new Map(d.members.map(m => [m.k, m.name]));
  return fc.filter(f => series.has(f.k)).map(f => ({ name: names.get(f.k) ?? '', slot: f.slot, values: series.get(f.k) }));
}

// シーズン内の累積 pt のグラフ（通算はシーズンごとに足し上げる）
function seasonChart(d) {
  const season = seasonOf(d), seats = seatsIn(d), fc = getFocus(d), ptFmt = v => fmtPt(Math.round(v * 10) / 10);
  const c = season === ALL ? cumulativeSeasons(d, seats) : cumulative(d.games, seats);
  const labels = season === ALL ? c.seasons.map(seasonShort) : c.days.map(dayShort);
  return { labels, series: focusSeries(d, fc, c.series), avg: c.series.size ? c.avg : null, fmt: ptFmt, zero: true, aria: seasonLabel(season) + 'の累積ポイント推移' };
}
// 見出し（押すと並べ替え。並べ替え中の列に ▼▲）
function sortThHTML(key, label, sort) {
  const on = sort.key === key;
  let aria = '', mark = '';
  if (on) { aria = sort.desc ? ' aria-sort="descending"' : ' aria-sort="ascending"'; mark = sort.desc ? ' ▼' : ' ▲'; }
  return `<th${aria}><button type="button" class="${cls('th-btn', on && 'on')}" data-sort="${key}">${label}${mark}</button></th>`;
}
function tableHTML(rows, fc, seats) {
  const cols = columnsFor(seats), total = totalOf(rows), per = total.players || 1;
  // 並べ替え中の列がこの人数で出ていなければ、合計の多い順
  const sort = S.sort.key === 'name' || cols.some(c => c.key === S.sort.key) ? S.sort : { key: 'pt', desc: true };
  // メンバー平均：合計と参加は 1 人あたり、ほかは全員ぶんを合わせた値
  const perMember = { pt: fmtNum(total.pt / per, 1), n: fmtNum(total.n / per, 1) };
  const avgCells = cols.map(c => td(perMember[c.key] ?? CELL[c.key](total))).join('');
  const body = sortRows(rows, sort.key, sort.desc).map(r => memberTr(r, r.me, slotOf(fc, r.k), metricCells(r, cols))).join('');
  return tableWrap(sortThHTML('name', '名前', sort) + cols.map(c => sortThHTML(c.key, c.label, sort)).join(''), '<tr class="avg-row">' + AVG_CELL + avgCells + '</tr>' + body);
}
// 自分の数字。すべての卓では 4 つ目を参加数にし、順位は人数ごとの表で出す。人数を選んだら平均順位と、その人数での順位の分布
function fourthTile(mine, seats) {
  if (!mine) return seats === ALL ? statTile('参加', '–') : statTile('平均順位', '–');
  if (seats === ALL) return statTile('参加', String(mine.n), '戦', '生存T ' + fmtNum(mine.survival, 1));
  return statTile('平均順位', fmtNum(mine.avgPlace), '位', '1位率 ' + fmtRate(mine.firstRate));
}
function youHTML(d, season, seats, mine, count) {
  const fourth = fourthTile(mine, seats);
  let places = EMPTY;
  if (seats === ALL) places = placeTableHTML(placeRows(d, d.me, season));
  else if (mine) {
    const dist = mine.dist.slice(0, seats), max = Math.max(1, ...dist);
    places = `<div class="spd">${dist.map((c, i) => distRowHTML(c, i, max, mine.n)).join('')}</div>`;
  }
  return `<div class="panel hs-panel fr-panel">
      <div class="hs-head"><span class="hs-title">YOU</span><span class="hs-total">メンバー <b>${count}</b></span></div>
      <div class="hs-grid4">
        ${statTile('順位', mine ? mine.rank : '–', '/ ' + count)}
        ${statTile('合計', mine ? fmtPt(mine.pt) : '–', 'pt', '', mine ? toneOf(mine.pt) : '')}
        ${statTile('平均 ・ 加点率', fmtNum(mine?.avg ?? null), '', mine ? '加点率 ' + fmtRate(mine.plusRate) : '')}
        ${fourth}
      </div>
    </div>
    <div class="panel hs-panel fr-panel">
      <div class="hs-head"><span class="hs-title">順位</span><span class="hs-total">${seats === ALL ? '人数別' : esc(seatsLabel(seats)) + 'の卓'}</span></div>
      ${places}
    </div>`;
}
function seasonViewHTML(d) {
  const season = seasonOf(d), seats = seatsIn(d), rows = memberRows(d, season, seats), ranked = ranking(rows), fc = getFocus(d), mine = ranked.find(r => r.me);
  const top = ranked.slice(0, TOP), list = mine && !top.includes(mine) ? [...top, mine] : top;
  return `${youHTML(d, season, seats, mine, ranked.length)}
    <div class="panel hs-panel fr-panel">
      <div class="hs-head"><span class="hs-title">RANKING</span><button class="back" id="toRank" type="button">ALL →</button></div>
      ${rankListHTML(list, seats)}
    </div>
    <div class="panel hs-panel fr-panel"><span class="hs-title">累積ポイント推移</span>
      ${lineChartHTML(seasonChart(d))}${chipsHTML(rows, fc)}
    </div>
    <div class="panel hs-panel fr-panel"><span class="hs-title">メンバー別</span>${rows.length ? tableHTML(rows, fc, seats) : EMPTY}</div>`;
}

// シーズン推移：選んだ指標のシーズンごとの線と表（新しいシーズンが左）
// 選んだ指標（その人数で選べなければ合計ポイント）
const metricOf = seats => { const list = trendMetricsFor(seats); return list.find(m => m.key === S.metric) ?? list[0]; };
const isPct = key => key === 'plusRate' || key === 'firstRate';
function metricFmt(key, v) {
  if (key === 'pt') return fmtPt(Math.round(v * 10) / 10);
  if (isPct(key)) return v.toFixed(1) + '%';
  return v.toFixed(key === 'survival' ? 1 : 2);
}
function metricTick(key, v) {
  if (key === 'pt') return fmtPt(Math.round(v));
  const s = String(Number(v.toFixed(1)));
  return isPct(key) ? s + '%' : s;
}
function trendChart(d, t) {
  const m = metricOf(seatsIn(d));
  return {
    labels: t.seasons.map(seasonShort), series: focusSeries(d, getFocus(d), t.series), avg: t.avg, fmt: v => metricFmt(m.key, v), tick: v => metricTick(m.key, v),
    zero: m.key === 'pt' || m.key === 'avg', aria: m.label + 'のシーズン推移',
  };
}
// そのシーズン推移に値のある人
const trendMembers = (d, t) => d.members.filter(x => t.series.get(x.k)?.some(v => v != null));
function trendTableHTML(d, t, fc) {
  const m = metricOf(seatsIn(d)), order = t.seasons.map((_, i) => i).reverse();
  const cells = values => order.map(i => td(values[i] == null ? '–' : metricFmt(m.key, values[i]))).join('');
  const body = trendMembers(d, t).map(x => memberTr(x, x.k === d.me, slotOf(fc, x.k), cells(t.series.get(x.k)))).join('');
  return tableWrap(th('名前') + order.map(i => th(esc(seasonShort(t.seasons[i])))).join(''), '<tr class="avg-row">' + AVG_CELL + cells(t.avg) + '</tr>' + body);
}
function trendViewHTML(d) {
  const m = metricOf(seatsIn(d)), t = trend(d, m.key, seatsIn(d)), fc = getFocus(d), members = trendMembers(d, t);
  return `<div class="panel hs-panel fr-panel"><span class="hs-title">${m.label}の推移</span>
      ${lineChartHTML(trendChart(d, t))}${chipsHTML(members, fc)}
    </div>
    <div class="panel hs-panel fr-panel"><div class="hs-head"><span class="hs-title">${m.label}</span><span class="hs-total">${m.unit}</span></div>
      ${members.length ? trendTableHTML(d, t, fc) : EMPTY}</div>`;
}

function setFocus(next) { focus = next; localSet(FOCUS_KEY, JSON.stringify(next)); rerender(); }
function bindStatsPane(el) {
  bindCommon(el);
  const d = S.data;
  el.querySelectorAll('[data-view]').forEach(b => b.onclick = () => { S.view = b.dataset.view; rerender(); });
  const ms = el.querySelector('#metricSel');
  if (ms) ms.onchange = () => { S.metric = ms.value; rerender(); };
  const tr = el.querySelector('#toRank');
  if (tr) tr.onclick = () => openPane('frank');
  el.querySelectorAll('[data-sort]').forEach(b => b.onclick = () => {
    const key = b.dataset.sort;
    S.sort = { key, desc: S.sort.key === key ? !S.sort.desc : true };
    rerender();
  });
  if (!d) return;
  el.querySelectorAll('[data-chip]').forEach(b => b.onclick = () => setFocus(toggleFocus(getFocus(d), b.dataset.chip)));
  const clear = el.querySelector('#chipClear');
  if (clear) clear.onclick = () => setFocus([]);
  const chart = el.querySelector('.lc');
  if (chart) bindLineChart(chart, S.view === 'season' ? seasonChart(d) : trendChart(d, trend(d, metricOf(seatsIn(d)).key, seatsIn(d))));
}

/* ===================== メンバーの詳細（通算・人数ごとの順位・シーズン別・最近の記録） ===================== */
// 順位の分布の 1 行（count 回・全体の何 %）
function distRowHTML(count, i, max, n) {
  return `<div class="spd-row fr-dist"><span class="spd-label">${i + 1}位</span><span class="spd-bar"><span class="${cls('spd-fill', i === 0 && 'first')}" style="width:${(count / max) * 100}%"></span></span>
    <span class="spd-count">${count}<small> ・ ${Math.round((count / n) * 100)}%</small></span></div>`;
}
const recentRowHTML = g => `<li><span>${esc(dayShort(dayOf(g.at)))}</span><span>${g.p ? esc(seatsLabel(+g.p)) : ''}</span><b>${+g.place}位</b><span class="${toneOf(g.pt)}">${fmtPt(g.pt)}pt</span></li>`;
function recentHTML(d, k) {
  const recent = d.games.filter(g => g.k === k).slice(-10).reverse();
  if (!recent.length) return '';
  return `<h3>最近の記録 <span>${esc(seasonLabel(d.season))}</span></h3><ul class="fr-recs">` + recent.map(recentRowHTML).join('') + '</ul>';
}
function openMember(k) {
  const d = S.data, who = d?.members.find(m => m.k === k);
  if (!who) return;
  const all = memberRows(d, ALL).find(r => r.k === k), cols = columnsFor(ALL);
  const seasons = [...d.seasons].reverse().map(s => [s, memberRows(d, s).find(r => r.k === k)]).filter(([, r]) => r);
  $('#memberBody').innerHTML = head('MEMBER', esc(who.name)) + `<p class="hint">${esc(modeLabel(S.mode))}</p>
    <div class="hs-grid fr-grid">
      ${statTile('通算', fmtPt(all.pt), 'pt', all.n + ' 戦', toneOf(all.pt))}
      ${statTile('平均 ・ 加点率', fmtNum(all.avg), '', '加点率 ' + fmtRate(all.plusRate))}
      ${statTile('生存ターン', fmtNum(all.survival, 1))}
      ${statTile('VPIP', fmtRate(all.vpipRate))}
      ${statTile('PFR', fmtRate(all.pfrRate))}
      ${statTile('HANDS', all.hands.toLocaleString())}
    </div>
    <h3>順位 <span>人数別</span></h3>${placeTableHTML(placeRows(d, k), seatsIn(d))}
    <h3>シーズン別</h3>
    ${tableWrap(th('シーズン') + cols.map(c => th(c.label)).join(''), seasons.map(([s, r]) => '<tr>' + td(esc(seasonShort(s))) + metricCells(r, cols) + '</tr>').join(''))}
    ${recentHTML(d, k)}`;
  openDlg('#memberDlg');
}
