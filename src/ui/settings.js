// 設定のモーダル（#setDlg）：入口（ベットサイズ・演出 GIF の 2 つのボタン）→ それぞれのページ。ヘッダの歯車とメニューの SETTINGS から開く。
// どちらも端末に保存（localStorage）。演出 GIF を選べない（KLIPY のキーが無い）ときは入口を出さずにベットサイズを開く。
// ベットサイズの候補の計算は src/betsize.js。卓のベットのシート（table.js）は開くたびに getSizes() を読む。演出 GIF のページは src/ui/gif.js。
import { STEPS, MAX_ITEMS, SCENES, UNITS, normalizeSizes, defaultSizes, makeSize, sortSizes, parseSize } from '../betsize.js';
import { available as fxAvailable } from '../klipy.js';
import * as gif from './gif.js';
import { $, esc, head, openDlg, toast, localGet, localSet } from './util.js';

const KEY = 'pm-betsizes';
const TITLE = { open: 'Preflop · Open', vsRaise: 'Preflop · vs Raise', bet: 'Postflop · Bet', vsBet: 'Postflop · vs Bet / Raise' };
const UNIT_LABEL = { bb: 'BB', x: 'x', '%': '%' };

let sizes = null;
const unit = { vsRaise: 'x', vsBet: 'x' };   // 追加するときの単位（2 つある場面だけ）
let onChange = () => {};
let page = 'hub';   // 'hub' | 'bet' | 'fx'

export function getSizes() {
  if (!sizes) { try { sizes = normalizeSizes(JSON.parse(localGet(KEY))); } catch (e) { sizes = normalizeSizes(null); } }
  return sizes;
}
function save() { localSet(KEY, JSON.stringify(sizes)); onChange(); }
/** 設定が変わったら呼ぶ（開いているベットのシートを作り直す） */
export function onSizesChange(fn) { onChange = fn; }

export function openSettings() { getSizes(); gif.reset(); go(fxAvailable() ? 'hub' : 'bet'); openDlg('#setDlg'); }
function go(p) { page = p; paint(); $('#setBody').scrollTop = 0; }
const backHTML = () => (fxAvailable() ? '<button class="back" id="setBack" type="button">← BACK</button>' : '');
function paint() {
  const body = $('#setBody');
  body.onscroll = null;
  body.classList.toggle('fx-page', page === 'fx');   // 演出 GIF のページは一覧だけがスクロールする
  if (page === 'hub') {
    body.innerHTML = head('SETTINGS', '設定') + `<div class="set-hub">
      <button class="mbtn" data-go="bet" type="button"><span>ベットサイズ<small>Bet / Raise の候補・スライダーの刻み</small></span><span class="rt">→</span></button>
      <button class="mbtn" data-go="fx" type="button"><span>演出 GIF<small>PRIVATE MATCH のショーダウン</small></span><span class="rt">${gif.getFx() ? 'ON' : '→'}</span></button></div>`;
    body.querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
  } else if (page === 'fx') gif.paint(body, backHTML());
  else paintBet();
  const bk = $('#setBack'); if (bk) bk.onclick = () => go('hub');
}

function sceneHTML(sc) {
  const list = sizes[sc], full = list.length >= MAX_ITEMS, us = UNITS[sc], u = us.length > 1 ? unit[sc] : us[0];
  const useg = us.length > 1 ? `<div class="seg sz-unit" data-sc="${sc}">${us.map(x => `<button type="button" data-u="${x}" aria-pressed="${x === u}">${UNIT_LABEL[x]}</button>`).join('')}</div>` : '';
  return `<section class="sz" data-sc="${sc}">
    <h3>${TITLE[sc]}<span class="sz-n">${list.length}/${MAX_ITEMS}</span></h3>
    <div class="sz-add"><label class="sz-in"><input type="text" inputmode="decimal" autocomplete="off" maxlength="6" placeholder="0" aria-label="${TITLE[sc]}"${full ? ' disabled' : ''}><i>${UNIT_LABEL[u]}</i></label>${useg}<button class="btn sz-go" type="button" disabled>追加</button></div>
    <div class="sz-chips">${list.map(s => `<button class="sz-chip" type="button" data-del="${esc(s)}" aria-label="${esc(s)} を消す">${parseSize(s).v}<small>${UNIT_LABEL[parseSize(s).u]}</small><i aria-hidden="true"></i></button>`).join('')}<span class="sz-chip fixed">All-in</span></div>
  </section>`;
}
function paintBet() {
  const body = $('#setBody');
  body.innerHTML = backHTML() + head('SETTINGS', 'ベットサイズ') + `
    <section class="sz"><h3>Slider<span>BB</span></h3>
      <div class="seg" id="szStep">${STEPS.map(s => `<button type="button" data-s="${s}" aria-pressed="${sizes.step === s}">${s}</button>`).join('')}</div></section>
    ${SCENES.map(sceneHTML).join('')}
    <div class="btns"><button class="btn ghost" id="szReset" type="button">デフォルトに戻す</button></div>`;
  $('#szStep').onclick = e => { const b = e.target.closest('[data-s]'); if (!b) return; sizes.step = +b.dataset.s; save(); repaint(); };
  $('#szReset').onclick = () => { sizes = normalizeSizes(defaultSizes()); unit.vsRaise = unit.vsBet = 'x'; save(); repaint(); };
  body.querySelectorAll('section.sz[data-sc]').forEach(bind);
}
/** 描き直してもスクロールの位置は保つ */
function repaint() { const d = $('#setBody'), y = d.scrollTop; paint(); d.scrollTop = y; }

function bind(sec) {
  const sc = sec.dataset.sc, inp = sec.querySelector('input'), go = sec.querySelector('.sz-go');
  const cur = () => UNITS[sc].length > 1 ? unit[sc] : UNITS[sc][0];
  const valid = () => makeSize(sc, inp.value, cur());
  inp.oninput = () => { inp.value = inp.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1'); go.disabled = !inp.value || sizes[sc].length >= MAX_ITEMS; };
  const add = () => {
    if (go.disabled) return;
    const s = valid();
    if (!s) return toast(cur() === 'x' ? '1.1〜100 で入力してください' : '1〜1000 で入力してください');
    if (sizes[sc].includes(s)) return toast('すでにあります');
    sizes[sc] = sortSizes(sc, [...sizes[sc], s]); save(); repaint();
    const ni = $(`#setBody section[data-sc="${sc}"] input`); if (ni && !ni.disabled) ni.focus({ preventScroll: true });
  };
  go.onclick = add;
  inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
  const us = sec.querySelector('.sz-unit');
  if (us) us.onclick = e => {
    const b = e.target.closest('[data-u]'); if (!b) return;
    unit[sc] = b.dataset.u; us.querySelectorAll('[data-u]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    sec.querySelector('.sz-in i').textContent = UNIT_LABEL[unit[sc]];
  };
  sec.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { sizes[sc] = sizes[sc].filter(s => s !== b.dataset.del); save(); repaint(); });
}
