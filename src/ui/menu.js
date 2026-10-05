// メニューの画面：ログイン、メイン（PrivateMatch / FreeMatch / STATS）、部屋の作成、部屋番号で参加、FreeMatch の募集一覧、
// 参加前の確認、プロフィール。待機室は room.js、成績・履歴は stats.js が同じ #menuIn に描く。
import {
  PLAYER_COUNTS, START_BBS, SPEEDS, SPEED_LABEL, GAME_KINDS, GAME_KIND_LABELS, MODES_BY_KIND, GAME_MODES,
  DEFAULT_CONFIG, normalizeConfig, configSummary, modeLabel, chipsLabel,
} from '../structure.js';
import { $, app, esc, head, openDlg, toast, localGet, localSet } from './util.js';
import * as room from './room.js';
import * as stats from './stats.js';

const GSVG = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.9z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z"/></svg>';
const CFG_KEY = 'pm-config';
const FREE_POLL_MS = 5000;

// pane: 'main' | 'private' | 'free' | 'create' | 'join' | 'room' | 'stats' | 'history'
let pane = 'main';
let createKind = 'private';
let freeList = null, freeTimer = 0, freeGen = 0;
const root = () => $('#menuIn');

export const currentPane = () => pane;
export function setPane(p, opts = {}) {
  const m = $('#menu'); if (m) m.scrollTop = 0;
  if (pane === 'room' && p !== 'room') room.stop();
  if (pane === 'free' && p !== 'free') stopFree();
  pane = p;
  if (opts.kind) createKind = opts.kind;
  if (p === 'free') startFree();
  renderMenu();
}

/* ---------- 描画 ---------- */
export function renderMenu() {
  const el = root(); if (!el) return;
  if (!app.net.online) return paint(el, loginHTML(false));
  if (app.booting || (app.user && !app.prof)) return paint(el, loadingHTML);
  if (!app.user) return paint(el, loginHTML(true), bindLogin);
  if (pane === 'room') return room.render(el);
  if (pane === 'stats' || pane === 'history') return stats.render(el, pane);
  if (pane === 'private') return paint(el, privateHTML(), bindPrivate);
  if (pane === 'free') return paint(el, freeHTML(), bindFree);
  if (pane === 'create') return paint(el, createHTML(), bindCreate);
  if (pane === 'join') return paint(el, joinHTML(), bindJoin);
  paint(el, mainHTML(), bindMain);
}
export function paint(el, html, bind) {
  if (el._h === html) return;
  el._h = html; el.innerHTML = html; if (bind) bind(el);
}
const wordmark = '<div class="wordmark">PrivateMatch</div>';
const loadingHTML = `${wordmark}<div class="acct"><span class="dots" style="margin:14px 0"><i></i><i></i><i></i></span></div>`;
const back = (to = 'main') => `<button class="back" data-back="${to}" type="button">← BACK</button>`;
function bindBack(el) { el.querySelectorAll('[data-back]').forEach(b => b.onclick = () => setPane(b.dataset.back)); }

function loginHTML(online) {
  return `${wordmark}<p class="tagline">知り合いと気軽にポーカーの SIT &amp; GO</p>
    <div class="notice">部屋番号や招待 URL で集まって、ポーカーチェイスと同じストラクチャーで対戦できます。成績とハンド履歴はこの端末に保存されます。</div>
    <button class="gbtn" id="loginBtn" type="button" ${online ? '' : 'disabled'}>${GSVG}Google でログイン</button>
    ${online ? '' : '<p class="tagline">サーバーの設定がまだです（docs/SETUP.md）。開発中は <code>?fake</code> で画面を確認できます。</p>'}`;
}
function bindLogin(el) {
  el.querySelector('#loginBtn').onclick = async () => {
    try { await app.net.signIn(location.href) } catch (e) { toast('ログインを開始できませんでした') }
  };
}

function mainHTML() {
  const p = app.prof, r = p.room;
  return `${wordmark}
    <div class="acct"><button class="who-me" id="meBtn" type="button" aria-label="Profile"><i class="gem" style="width:9px;height:9px;transform:rotate(45deg);background:linear-gradient(135deg,#fff,var(--you) 65%)"></i><span class="nick">${esc(p.nickname)}</span><span class="bal"><small>EDIT</small></span></button></div>
    ${r ? `<button class="mbtn back-room" id="backRoom" type="button"><span>参加中の部屋へ戻る<small>部屋番号 ${esc(r.code)}</small></span><span class="rt">→</span></button>` : ''}
    <button class="mbtn" id="pmBtn" type="button"><span>PRIVATE MATCH<small>部屋番号・招待 URL で知り合いと</small></span></button>
    <button class="mbtn" id="fmBtn" type="button"><span>FREE MATCH<small>公開の部屋で誰とでも</small></span></button>
    <button class="mbtn" id="stBtn" type="button"><span>STATS<small>成績とハンド履歴</small></span></button>`;
}
function bindMain(el) {
  el.querySelector('#meBtn').onclick = openProfile;
  const br = el.querySelector('#backRoom'); if (br) br.onclick = () => app.nav.enterRoom(app.prof.room.id);
  el.querySelector('#pmBtn').onclick = () => setPane('private');
  el.querySelector('#fmBtn').onclick = () => setPane('free');
  el.querySelector('#stBtn').onclick = () => setPane('stats');
}

function privateHTML() {
  return `${back()}<div class="pane-h"><span class="eyebrow">PRIVATE MATCH</span></div>
    <button class="mbtn" id="pmCreate" type="button"><span>部屋を作る<small>部屋番号と招待 URL が発行されます</small></span><span class="rt">＋</span></button>
    <button class="mbtn" id="pmJoin" type="button"><span>部屋番号で入る<small>6 桁の番号を入力</small></span><span class="rt">#</span></button>`;
}
function bindPrivate(el) {
  bindBack(el);
  el.querySelector('#pmCreate').onclick = () => setPane('create', { kind: 'private' });
  el.querySelector('#pmJoin').onclick = () => setPane('join');
}

/* ---------- FreeMatch：作成ボタンと募集中の一覧 ---------- */
function freeHTML() {
  let list;
  if (freeList === null) list = '<div class="empty-note"><span class="dots" style="justify-content:center"><i></i><i></i><i></i></span></div>';
  else if (!freeList.length) list = '<div class="empty-note">いま募集中の部屋はありません。</div>';
  else list = `<ul class="rooms">${freeList.map(r => `<li><button class="room-row" type="button" data-code="${esc(r.code)}">
      <span class="rr-host">${esc(r.host || '')}</span><span class="rr-seat"><b>${r.seated}</b>/${r.config.players}</span>
      <span class="rr-meta">${chipsLabel(r.config.startBb)} ・ ${SPEED_LABEL[r.config.speed]} ・ ${esc(modeLabel(r.config.mode))}</span></button></li>`).join('')}</ul>`;
  return `${back()}<div class="pane-h"><span class="eyebrow">FREE MATCH</span></div>
    <button class="mbtn" id="fmCreate" type="button"><span>部屋を作る<small>一覧に公開され、誰でも参加できます</small></span><span class="rt">＋</span></button>
    <div class="list-h"><span class="eyebrow">募集中</span></div>${list}`;
}
function bindFree(el) {
  bindBack(el);
  el.querySelector('#fmCreate').onclick = () => setPane('create', { kind: 'free' });
  el.querySelectorAll('.room-row').forEach(b => b.onclick = () => openJoin(b.dataset.code));
}
function startFree() {
  stopFree(); const gen = ++freeGen; freeList = null;
  const tick = async () => {
    if (gen !== freeGen) return;
    try { const r = await app.net.rpc('free_rooms'); if (gen !== freeGen) return; freeList = Array.isArray(r) ? r : []; if (pane === 'free') renderMenu(); }
    catch (e) { if (gen === freeGen && freeList === null) { freeList = []; if (pane === 'free') renderMenu(); } }
    if (gen === freeGen) freeTimer = setTimeout(tick, document.hidden ? FREE_POLL_MS * 3 : FREE_POLL_MS);
  };
  tick();
}
function stopFree() { freeGen++; clearTimeout(freeTimer); }

/* ---------- 部屋の作成 ---------- */
function loadCfg() { try { return normalizeConfig(JSON.parse(localGet(CFG_KEY))) || { ...DEFAULT_CONFIG }; } catch (e) { return { ...DEFAULT_CONFIG }; } }
let cfg = null;
const seg = (key, values, label) => `<div class="seg form-seg" data-key="${key}">${values.map(v => `<button type="button" data-v="${v}" aria-pressed="${cfg[key] === v}">${label(v)}</button>`).join('')}</div>`;
function createHTML() {
  if (!cfg) cfg = loadCfg();
  const kind = GAME_MODES[cfg.mode].kind, variants = MODES_BY_KIND[kind];
  const kindSeg = `<div class="seg form-seg" data-key="kind">${GAME_KINDS.map(k => `<button type="button" data-v="${k}" aria-pressed="${kind === k}">${GAME_KIND_LABELS[k]}</button>`).join('')}</div>`;
  const varSeg = variants.length > 1 ? `<div class="seg form-seg" data-key="mode">${variants.map(m => `<button type="button" data-v="${m}" aria-pressed="${cfg.mode === m}">${kind === 'rank' ? 'STAGE ' + GAME_MODES[m].variant : GAME_MODES[m].variant}</button>`).join('')}</div>` : '';
  const pay = GAME_MODES[cfg.mode].payouts.slice(0, cfg.players).map((v, i) => `<span><i>${i + 1}位</i>${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v)}</span>`).join('');
  return `${back(createKind === 'free' ? 'free' : 'private')}<div class="pane-h"><span class="eyebrow">${createKind === 'free' ? 'FREE MATCH' : 'PRIVATE MATCH'}</span><b>部屋を作る</b></div>
    <div class="form">
      <span class="lbl">人数</span>${seg('players', PLAYER_COUNTS, v => v + '人')}
      <span class="lbl">初期チップ</span>${seg('startBb', START_BBS, chipsLabel)}
      <span class="lbl">ブラインド構造</span>${seg('speed', SPEEDS, v => SPEED_LABEL[v])}
      <span class="lbl">ゲームモード（プライズ）</span>${kindSeg}${varSeg}
      <div class="blinds pays">${pay}</div>
    </div>
    <button class="btn primary big" id="createBtn" type="button">部屋を作成</button>`;
}
function bindCreate(el) {
  bindBack(el);
  el.querySelectorAll('.form-seg').forEach(s => s.onclick = e => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    const k = s.dataset.key, v = b.dataset.v;
    if (k === 'kind') cfg.mode = MODES_BY_KIND[v][0];
    else cfg[k] = k === 'speed' || k === 'mode' ? v : +v;
    localSet(CFG_KEY, JSON.stringify(cfg)); renderMenu();
  });
  const btn = el.querySelector('#createBtn');
  btn.onclick = async () => {
    if (btn.disabled) return; btn.disabled = true;
    try {
      const r = await app.net.game({ op: 'create', kind: createKind, config: cfg });
      app.prof && (app.prof.room = { id: r.room, code: r.view.room.code, kind: createKind, status: 'waiting', started: false });
      app.nav.enterRoom(r.room, r);
    } catch (e) { btn.disabled = false; showJoinError(e); }
  };
}

/* ---------- 部屋番号で参加 ---------- */
function joinHTML() {
  return `${back('private')}<div class="pane-h"><span class="eyebrow">PRIVATE MATCH</span><b>部屋番号で入る</b></div>
    <input class="tin code-in" id="codeIn" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" placeholder="000000" aria-label="部屋番号">
    <button class="btn primary big" id="codeGo" type="button" disabled>次へ</button>`;
}
function bindJoin(el) {
  bindBack(el);
  const inp = el.querySelector('#codeIn'), go = el.querySelector('#codeGo');
  inp.oninput = () => { inp.value = inp.value.replace(/\D/g, '').slice(0, 6); go.disabled = inp.value.length !== 6; };
  inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); if (!go.disabled) go.click(); } };
  go.onclick = () => openJoin(inp.value);
  setTimeout(() => inp.focus(), 50);
}

/* ---------- 参加前の確認（番号入力・招待 URL・一覧から） ---------- */
export async function openJoin(code) {
  const body = $('#joinBody');
  body.innerHTML = head('JOIN', `部屋 ${esc(code)}`) + '<div class="empty-note"><span class="dots" style="justify-content:center"><i></i><i></i><i></i></span></div>';
  openDlg('#joinDlg');
  let r;
  try { r = await app.net.rpc('room_peek', { p_code: code }); }
  catch (e) { body.innerHTML = head('JOIN', `部屋 ${esc(code)}`) + '<p>読み込めませんでした。</p>'; return; }
  if (!r) { body.innerHTML = head('JOIN', `部屋 ${esc(code)}`) + '<p>部屋が見つかりません。番号を確かめてください。</p>'; return; }
  if (r.member && ['waiting', 'running', 'paused'].includes(r.status)) { $('#joinDlg').close(); app.nav.enterRoom(r.id); return; }
  const open = r.status === 'waiting' && r.seated < r.config.players;
  const why = r.status === 'waiting' ? '満員です。' : ['running', 'paused'].includes(r.status) ? 'この部屋はもう始まっています。' : 'この部屋は終わっています。';
  body.innerHTML = head(r.kind === 'free' ? 'FREE MATCH' : 'PRIVATE MATCH', `部屋 ${esc(r.code)}`) +
    `<dl class="spec"><dt>作成者</dt><dd>${esc(r.host || '')}</dd><dt>参加</dt><dd>${r.seated} / ${r.config.players} 人</dd><dt>設定</dt><dd>${esc(configSummary(r.config))}</dd></dl>
    ${open ? '' : `<p class="err">${why}</p>`}
    <div class="btns"><button class="btn ghost" data-close type="button">Cancel</button><button class="btn primary" id="joinGo" type="button" ${open ? '' : 'disabled'}>参加する</button></div>`;
  const go = $('#joinGo');
  go.onclick = async () => {
    go.disabled = true;
    try { const x = await app.net.game({ op: 'join', code: r.code }); $('#joinDlg').close(); app.nav.enterRoom(x.room, x); }
    catch (e) { go.disabled = false; $('#joinDlg').close(); showJoinError(e); }
  };
}
export function showJoinError(e) {
  const code = e && e.code;
  if (code === 'in_other_room' && e.data && e.data.room) { toast('参加中の部屋があります'); app.nav.enterRoom(e.data.room); return; }
  toast({ room_full: '満員です', room_closed: 'この部屋には参加できません', not_found: '部屋が見つかりません', busy: '混み合っています。もう一度',
    malformed: '設定を確かめてください' }[code] || '通信エラー。もう一度');
}

/* ---------- プロフィール ---------- */
export function openProfile() {
  const p = app.prof; if (!p) return;
  $('#profBody').innerHTML = head('PROFILE', 'Nickname') +
    `<input class="tin" id="nickIn" maxlength="16" value="${esc(p.nickname)}" autocomplete="off" spellcheck="false" aria-label="Nickname">
    <div class="err" id="nickErr" role="alert" hidden></div>
    <p class="hint">卓で相手に見える名前です（1〜16 文字）。</p>
    <div class="btns"><button class="btn ghost" id="logoutBtn" type="button">ログアウト</button><button class="btn primary" id="nickSave" type="button">保存</button></div>`;
  openDlg('#profDlg');
  $('#nickSave').onclick = saveNick;
  $('#logoutBtn').onclick = async () => { $('#profDlg').close(); await app.nav.logout(); };
  $('#nickIn').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); saveNick(); } };
}
async function saveNick() {
  const v = $('#nickIn').value.trim(), err = $('#nickErr');
  if (v === app.prof.nickname) return $('#profDlg').close();
  try { await app.net.rpc('set_nickname', { p_name: v }); await app.nav.refreshMe(); $('#profDlg').close(); }
  catch (e) { err.hidden = false; err.textContent = e.code === 'nickname_taken' ? 'その名前は使われています' : e.code === 'nickname_invalid' ? '1〜16文字で入力してください' : '保存できませんでした'; }
}
