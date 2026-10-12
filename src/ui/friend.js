// FRIEND MATCH の画面：入口（部屋を作る / 部屋番号で入る / STATS / RANKING）、Discord のメンバー確認、スタッツ、ランキング。
// 専用の Discord サーバーのメンバーだけが入れる（確認は Function "game" の discord_start / discord_link。server/game/discord.js）。
// スタッツとランキングはサーバーに残した FRIEND MATCH の結果から（RPC friend_stats。集計は src/friend.js）。
// 表示の項目と形は Kagaribi Stat Hub のスタッツビュー：シーズン内（累積 pt のグラフ・メンバー別の表）とシーズン推移（指標ごとのグラフと表）。
// ゲームモードをまたいで混ぜない。シーズンは日本時間の暦月。
import { MODE_IDS, modeLabel } from '../structure.js';
import { $, app, esc, head, openDlg, toast, fmtPt, localGet, localSet, statTile, INVITE_KEY } from './util.js';
import { paint, setPane, currentPane } from './menu.js';
import { modeSegHTML, bindModeSeg } from './modeseg.js';
import { lineChartHTML, bindLineChart } from './linechart.js';
import {
  ALL, MAX_FOCUS, COLUMNS, TREND_METRICS, seasonLabel, seasonShort, dayShort, memberRows, totalOf, ranking, sortRows,
  cumulative, cumulativeSeasons, trend, toggleFocus, slotOf, parseFocus, fmtRate, fmtNum, dayOf,
} from '../friend.js';

const MODE_KEY = 'pm-friend-mode', FOCUS_KEY = 'pm-friend-focus', STATE_KEY = 'pm-discord';
const FRESH_MS = 30_000;   // 同じモード・シーズンを読み直すまでの間
const TOP = 5;             // スタッツの画面に出すランキングの人数
const DOTS = '<div class="empty-note"><span class="dots" style="justify-content:center"><i></i><i></i><i></i></span></div>';
const EMPTY = '<div class="empty-note">まだ記録がありません。</div>';
const backBtn = to => `<button class="back" data-back="${to}" type="button">← BACK</button>`;

// season: null = 最新のシーズン / ALL = 通算 / '2026-10'。sort.desc = 良い順
const S = { mode: null, season: null, view: 'season', metric: 'pt', sort: { key: 'pt', desc: true }, data: null, loading: false, failed: false, gen: 0 };
const cache = new Map();   // `${mode}|${season}` → { at, data }
let focus = null;          // グラフで強調する人 [{ k, slot }]（null = まだ選んでいない：自分だけ）

/** その人が FRIEND MATCH に入れるか（Discord での確認が切れていない。サーバーも同じことを確かめる） */
export const isFriend = () => !!app.prof?.friend?.ok;

/* ===================== Discord のメンバー確認 ===================== */
const LINK_ERR = { not_member: 'Discord のメンバーではありません', friend_off: 'FRIEND MATCH は準備中です', too_many: '回数が多すぎます。しばらく待ってから' };
const randomState = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
function sessionSet(k, v) { try { sessionStorage.setItem(k, v); } catch { /* プライベートモード */ } }
function sessionTake(k) {
  try { const v = sessionStorage.getItem(k); sessionStorage.removeItem(k); return v; } catch { return null; }
}

/** メニューの FRIEND MATCH：確認済みなら入口へ、まだなら Discord での確認へ */
export function openFriend() {
  if (isFriend()) return setPane('friend');
  openGate();
}
/** Discord での確認のダイアログ。invite = 確認のあとに入る部屋番号（招待 URL から来たとき） */
export function openGate(invite = null) {
  $('#gateBody').innerHTML = head('FRIEND MATCH', 'Discord') +
    '<div class="btns"><button class="btn primary" id="gateGo" type="button">Discord で確認</button></div>';
  openDlg('#gateDlg');
  const go = $('#gateGo');
  go.onclick = async () => {
    go.disabled = true;
    try { await startDiscord(invite); } catch (e) { go.disabled = false; toast(LINK_ERR[e.code] || '確認を始められませんでした'); }
  };
}
// Discord の同意の画面へ（このページを離れる）。戻りを照合する state と、あとで入る部屋番号はセッションに預ける
async function startDiscord(invite) {
  const state = randomState();
  const r = await app.net.game({ op: 'discord_start', state });
  sessionSet(STATE_KEY, state);
  if (invite) sessionSet(INVITE_KEY, invite);
  location.assign(r.url);
}
/**
 * 起動時：Discord から戻ってきた URL（?code=…&state=… / ?error=…&state=…）なら、その値を受け取って URL から消す。
 * state が預けたものと違えば受け取らない。=> { code } | { error } | null
 */
export function takeReturn() {
  const u = new URL(location.href), state = u.searchParams.get('state');
  if (!state) return null;
  const mine = sessionTake(STATE_KEY) === state, code = u.searchParams.get('code'), error = u.searchParams.get('error');
  for (const k of ['code', 'state', 'error', 'error_description']) u.searchParams.delete(k);
  history.replaceState(null, '', u.pathname + u.search + u.hash);
  if (!mine || (!code && !error)) return null;
  return code ? { code } : { error };
}
/** takeReturn の値をサーバーで確かめる（ログイン済みのとき）。=> 確認できたか */
export async function finishReturn(ret) {
  if (!ret.code) { toast('Discord の確認を中止しました'); return false; }
  try { await app.net.game({ op: 'discord_link', code: ret.code }); }
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

function seasonSelHTML(d) {
  const picked = d ? seasonOf(d) : S.season ?? '', seasons = [...(d?.seasons ?? [])].reverse();
  const opt = s => `<option value="${esc(s)}"${s === picked ? ' selected' : ''}>${esc(seasonLabel(s))}</option>`;
  return `<select class="tin fr-sel" id="seasonSel" aria-label="シーズン"${d ? '' : ' disabled'}>${seasons.map(opt).join('')}${opt(ALL)}</select>`;
}
function bindCommon(el) {
  bindBack(el);
  bindModeSeg(el, () => S.mode, m => { S.mode = m; localSet(MODE_KEY, m); S.season = S.season === ALL ? ALL : null; refresh(); });
  const sel = el.querySelector('#seasonSel');
  if (sel) sel.onchange = () => { S.season = sel.value; refresh(); };
  el.querySelectorAll('[data-member]').forEach(b => b.onclick = () => openMember(b.dataset.member));
}
const bodyWait = () => (S.failed ? '<div class="empty-note">読み込めませんでした。</div>' : DOTS);

/* ---------- ランキング ---------- */
function rankListHTML(list) {
  if (!list.length) return EMPTY;
  return `<ol class="rk">${list.map(r => `<li><button class="rk-row${r.me ? ' me-row' : ''}${r.rank <= 3 ? ' top' : ''}" type="button" data-member="${esc(r.k)}">
      <span class="rk-no">${r.rank}</span><span class="rk-name">${esc(r.name)}${r.me ? ' <em>YOU</em>' : ''}</span>
      <b class="rk-pt ${toneOf(r.pt)}">${fmtPt(r.pt)}<small>pt</small></b>
      <span class="rk-sub">${r.n}戦 ・ 平均 ${fmtNum(r.avg)} ・ 1位 ${fmtRate(r.firstRate)} ・ 順位 ${fmtNum(r.avgPlace)}</span></button></li>`).join('')}</ol>`;
}
function rankPaneHTML() {
  const d = S.data;
  return `${backBtn('friend')}
    <div class="panel hs-panel fr-panel">
      <div class="hs-head"><span class="hs-title">RANKING</span><span class="hs-total">${esc(modeLabel(S.mode))}</span></div>
      <div class="hs-modes">${modeSegHTML(S.mode)}</div>
      ${seasonSelHTML(d)}
      ${d ? rankListHTML(ranking(memberRows(d, seasonOf(d)))) : bodyWait()}
    </div>`;
}
function bindRankPane(el) { bindCommon(el); }

/* ---------- スタッツ ---------- */
const VIEWS = [['season', 'シーズン内'], ['trend', 'シーズン推移']];
function statsPaneHTML() {
  const d = S.data;
  const pick = S.view === 'season' ? seasonSelHTML(d)
    : `<select class="tin fr-sel" id="metricSel" aria-label="指標">${TREND_METRICS.map(m => `<option value="${m.key}"${m.key === S.metric ? ' selected' : ''}>${m.label}</option>`).join('')}</select>`;
  let body = bodyWait();
  if (d) body = S.view === 'season' ? seasonViewHTML(d) : trendViewHTML(d);
  return `${backBtn('friend')}
    <div class="panel hs-panel fr-panel">
      <div class="hs-head"><span class="hs-title">FRIEND STATS</span><span class="hs-total">${esc(modeLabel(S.mode))}</span></div>
      <div class="hs-modes">${modeSegHTML(S.mode)}</div>
      <div class="seg fr-view">${VIEWS.map(([v, label]) => `<button type="button" data-view="${v}" aria-pressed="${S.view === v}">${label}</button>`).join('')}</div>
      ${pick}
    </div>${body}`;
}

// グラフの下のチップ（強調する人を選ぶ。グラフの凡例を兼ねる）
function chipsHTML(members, fc) {
  const full = fc.length >= MAX_FOCUS;
  const chip = m => {
    const slot = slotOf(fc, m.k);
    return `<button type="button" class="chip${slot == null ? '' : ` on s${slot + 1}`}" data-chip="${esc(m.k)}" aria-pressed="${slot != null}"${slot == null && full ? ' disabled' : ''}><i class="key"></i>${esc(m.name)}</button>`;
  };
  return `<div class="chips" role="group" aria-label="グラフで強調するメンバー"><span class="chip legend-avg"><i class="key"></i>平均</span>${members.map(chip).join('')}</div>
    <div class="chips-foot"><span>強調 ${fc.length} / ${MAX_FOCUS}</span>${fc.length ? '<button type="button" class="back" id="chipClear">すべて解除</button>' : ''}</div>`;
}
// 強調した人の線（そのグラフに値のある人だけ）
function focusSeries(d, fc, series) {
  const names = new Map(d.members.map(m => [m.k, m.name]));
  return fc.filter(f => series.has(f.k)).map(f => ({ name: names.get(f.k) ?? '', slot: f.slot, values: series.get(f.k) }));
}

// シーズン内の累積 pt のグラフ（通算はシーズンごとに足し上げる）
function seasonChart(d) {
  const season = seasonOf(d), fc = getFocus(d), ptFmt = v => fmtPt(Math.round(v * 10) / 10);
  const c = season === ALL ? cumulativeSeasons(d) : cumulative(d.games);
  const labels = season === ALL ? c.seasons.map(seasonShort) : c.days.map(dayShort);
  return { labels, series: focusSeries(d, fc, c.series), avg: c.series.size ? c.avg : null, fmt: ptFmt, zero: true, aria: `${seasonLabel(season)}の累積ポイント推移` };
}
function tableHTML(rows, fc) {
  const total = totalOf(rows), per = total.players || 1;
  const mark = key => { if (S.sort.key !== key) { return ''; } return S.sort.desc ? ' ▼' : ' ▲'; };
  const th = (key, label) => `<th${S.sort.key === key ? ` aria-sort="${S.sort.desc ? 'descending' : 'ascending'}"` : ''}><button type="button" class="th-btn${S.sort.key === key ? ' on' : ''}" data-sort="${key}">${label}${mark(key)}</button></th>`;
  const cells = r => `<td class="${toneOf(r.pt)}">${fmtPt(r.pt)}</td><td>${fmtNum(r.avg)}</td><td>${fmtRate(r.plusRate)}</td><td>${fmtRate(r.firstRate)}</td><td>${fmtNum(r.avgPlace)}</td><td>${r.n}</td><td>${fmtNum(r.survival, 1)}</td>`;
  const row = r => {
    const slot = slotOf(fc, r.k);
    return `<tr class="clk${r.me ? ' me-row' : ''}" data-member="${esc(r.k)}"><td><span class="nmcell${slot == null ? '' : ` s${slot + 1}`}"><i class="key"></i>${esc(r.name)}</span></td>${cells(r)}</tr>`;
  };
  return `<div class="tbl-scroll"><table class="tbl fr-tbl">
      <thead><tr>${th('name', '名前')}${COLUMNS.map(c => th(c.key, c.label)).join('')}</tr></thead>
      <tbody><tr class="avg-row"><td><span class="nmcell legend-avg"><i class="key"></i>メンバー平均</span></td>
        <td>${fmtNum(total.pt / per, 1)}</td><td>${fmtNum(total.avg)}</td><td>${fmtRate(total.plusRate)}</td><td>${fmtRate(total.firstRate)}</td><td>${fmtNum(total.avgPlace)}</td><td>${fmtNum(total.n / per, 1)}</td><td>${fmtNum(total.survival, 1)}</td></tr>
      ${sortRows(rows, S.sort.key, S.sort.desc).map(row).join('')}</tbody></table></div>`;
}
function seasonViewHTML(d) {
  const season = seasonOf(d), rows = memberRows(d, season), ranked = ranking(rows), fc = getFocus(d), mine = ranked.find(r => r.me);
  const top = ranked.slice(0, TOP), list = mine && !top.includes(mine) ? [...top, mine] : top;
  return `<div class="panel hs-panel fr-panel">
      <div class="hs-head"><span class="hs-title">YOU</span><span class="hs-total">メンバー <b>${rows.length}</b></span></div>
      <div class="hs-grid4">
        ${statTile('順位', mine ? mine.rank : '–', `/ ${ranked.length}`)}
        ${statTile('合計', mine ? fmtPt(mine.pt) : '–', 'pt', '', mine ? toneOf(mine.pt) : '')}
        ${statTile('平均 ・ 加点率', fmtNum(mine?.avg ?? null), '', mine ? `加点率 ${fmtRate(mine.plusRate)}` : '')}
        ${statTile('平均順位', fmtNum(mine?.avgPlace ?? null), '位', mine ? `1位率 ${fmtRate(mine.firstRate)}` : '')}
      </div>
    </div>
    <div class="panel hs-panel fr-panel">
      <div class="hs-head"><span class="hs-title">RANKING</span><button class="back" id="toRank" type="button">ALL →</button></div>
      ${rankListHTML(list)}
    </div>
    <div class="panel hs-panel fr-panel"><span class="hs-title">累積ポイント推移</span>
      ${lineChartHTML(seasonChart(d))}${chipsHTML(rows, fc)}
    </div>
    <div class="panel hs-panel fr-panel"><span class="hs-title">メンバー別</span>${rows.length ? tableHTML(rows, fc) : EMPTY}</div>`;
}

// シーズン推移：選んだ指標のシーズンごとの線と表（新しいシーズンが左）
const metricOf = () => TREND_METRICS.find(m => m.key === S.metric) ?? TREND_METRICS[0];
function metricFmt(key, v) {
  if (key === 'pt') return fmtPt(Math.round(v * 10) / 10);
  if (key === 'plusRate' || key === 'firstRate') return `${v.toFixed(1)}%`;
  return v.toFixed(key === 'survival' ? 1 : 2);
}
const metricTick = (key, v) => (key === 'pt' ? fmtPt(Math.round(v)) : String(Number(v.toFixed(1))) + (key === 'plusRate' || key === 'firstRate' ? '%' : ''));
function trendChart(d, t) {
  const m = metricOf();
  return {
    labels: t.seasons.map(seasonShort), series: focusSeries(d, getFocus(d), t.series), avg: t.avg, fmt: v => metricFmt(m.key, v), tick: v => metricTick(m.key, v),
    zero: m.key === 'pt' || m.key === 'avg', aria: `${m.label}のシーズン推移`,
  };
}
function trendTableHTML(d, t, fc) {
  const m = metricOf(), order = t.seasons.map((_, i) => i).reverse(), cell = v => (v == null ? '–' : metricFmt(m.key, v));
  const members = d.members.filter(x => t.series.get(x.k)?.some(v => v != null));
  const row = x => {
    const slot = slotOf(fc, x.k);
    return `<tr class="clk${x.k === d.me ? ' me-row' : ''}" data-member="${esc(x.k)}"><td><span class="nmcell${slot == null ? '' : ` s${slot + 1}`}"><i class="key"></i>${esc(x.name)}</span></td>${order.map(i => `<td>${cell(t.series.get(x.k)[i])}</td>`).join('')}</tr>`;
  };
  return `<div class="tbl-scroll"><table class="tbl fr-tbl">
      <thead><tr><th>名前</th>${order.map(i => `<th>${esc(seasonShort(t.seasons[i]))}</th>`).join('')}</tr></thead>
      <tbody><tr class="avg-row"><td><span class="nmcell legend-avg"><i class="key"></i>メンバー平均</span></td>${order.map(i => `<td>${cell(t.avg[i])}</td>`).join('')}</tr>
      ${members.map(row).join('')}</tbody></table></div>`;
}
function trendViewHTML(d) {
  const m = metricOf(), t = trend(d, m.key), fc = getFocus(d), members = d.members.filter(x => t.series.get(x.k)?.some(v => v != null));
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
  if (chart) bindLineChart(chart, S.view === 'season' ? seasonChart(d) : trendChart(d, trend(d, metricOf().key)));
}

/* ===================== メンバーの詳細（通算・順位の分布・シーズン別・最近の記録） ===================== */
function openMember(k) {
  const d = S.data, who = d?.members.find(m => m.k === k);
  if (!who) return;
  const all = memberRows(d, ALL).find(r => r.k === k), max = Math.max(1, ...all.dist);
  const dist = all.dist.map((c, i) => `<div class="spd-row fr-dist"><span class="spd-label">${i + 1}位</span><span class="spd-bar"><span class="spd-fill${i === 0 ? ' first' : ''}" style="width:${(c / max) * 100}%"></span></span><span class="spd-count">${c}<small> ・ ${Math.round((c / all.n) * 100)}%</small></span></div>`).join('');
  const seasons = [...d.seasons].reverse().map(s => [s, memberRows(d, s).find(r => r.k === k)]).filter(([, r]) => r);
  const recent = d.games.filter(g => g.k === k).slice(-10).reverse();
  $('#memberBody').innerHTML = head('MEMBER', esc(who.name)) + `<p class="hint">${esc(modeLabel(S.mode))}</p>
    <div class="hs-grid fr-grid">
      ${statTile('通算', fmtPt(all.pt), 'pt', `${all.n} 戦`, toneOf(all.pt))}
      ${statTile('平均 ・ 加点率', fmtNum(all.avg), '', `加点率 ${fmtRate(all.plusRate)}`)}
      ${statTile('1位率 ・ 平均順位', fmtRate(all.firstRate), '', `平均 ${fmtNum(all.avgPlace)} 位`)}
      ${statTile('VPIP', fmtRate(all.vpipRate), '', `${all.hands.toLocaleString()} HANDS`)}
      ${statTile('PFR', fmtRate(all.pfrRate))}
      ${statTile('生存ターン', fmtNum(all.survival, 1))}
    </div>
    <h3>順位の分布</h3><div class="spd">${dist}</div>
    <h3>シーズン別</h3>
    <div class="tbl-scroll"><table class="tbl fr-tbl"><thead><tr><th>シーズン</th>${COLUMNS.map(c => `<th>${c.label}</th>`).join('')}</tr></thead>
      <tbody>${seasons.map(([s, r]) => `<tr><td>${esc(seasonShort(s))}</td><td class="${toneOf(r.pt)}">${fmtPt(r.pt)}</td><td>${fmtNum(r.avg)}</td><td>${fmtRate(r.plusRate)}</td><td>${fmtRate(r.firstRate)}</td><td>${fmtNum(r.avgPlace)}</td><td>${r.n}</td><td>${fmtNum(r.survival, 1)}</td></tr>`).join('')}</tbody></table></div>
    ${recent.length ? `<h3>最近の記録 <span>${esc(seasonLabel(d.season))}</span></h3><ul class="fr-recs">${recent.map(g => `<li><span>${esc(dayShort(dayOf(g.at)))}</span><b>${+g.place}位</b><span class="${toneOf(g.pt)}">${fmtPt(g.pt)}pt</span></li>`).join('')}</ul>` : ''}`;
  openDlg('#memberDlg');
}
