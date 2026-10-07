// 設定の「演出 GIF」ページ（#setDlg の中。src/ui/settings.js が開く）：KLIPY で探して 1 つ選ぶ（なし も選べる。選ばなくてよい）。
// 端末に保存するのは slug だけ（localStorage pm-fx。デモは pm-fx-demo）。部屋を作る・入る・席に残る・再戦のときに PRIVATE MATCH なら
// サーバーへ送り、卓ではショーダウンで勝ったときに中央に出る（src/ui/fxshow.js）。
import * as klipy from '../klipy.js';
import { normalizeFx } from '../fx.js';
import { $, esc, head, localGet, localSet } from './util.js';

const key = () => (klipy.isDemo() ? 'pm-fx-demo' : 'pm-fx');
/** 選んでいる演出 GIF の slug（選べない・選んでいなければ null） */
export const getFx = () => (klipy.available() ? normalizeFx(localGet(key())) : null);
let onChange = () => {};
/** GIF を変えたときに呼ぶ（main.js：部屋に入っていればサーバーへ送る） */
export function onFxChange(fn) { onChange = fn; }
function setFx(slug) {
  const prev = getFx();
  localSet(key(), slug || '');
  if (getFx() !== prev) onChange(getFx());
}

// 開いている間の状態（検索語・読んだページ・結果）。seq で古い返事を捨てる
const S = { q: '', page: 0, items: [], next: false, busy: false, err: false, seq: 0 };
let qT = 0;
/** 設定を開き直したら検索を最初（トレンド）から */
export function reset() { Object.assign(S, { q: '', page: 0, items: [], next: false, busy: false, err: false }); S.seq++; }

const mediaHTML = (m, alt = '') => m.video
  ? `<video class="fx-m" src="${esc(m.url)}" muted loop autoplay playsinline preload="metadata" aria-label="${esc(alt)}"></video>`
  : `<img class="fx-m" src="${esc(m.url)}" alt="${esc(alt)}" loading="lazy" decoding="async">`;

/** ページを描く。top = 先頭に置く HTML（戻るボタン） */
export function paint(body, top) {
  body.innerHTML = top + head('SETTINGS', '演出 GIF') + `
    <div class="fx-cur"><div class="fx-cur-m" id="fxCur"></div><button class="btn ghost" id="fxNone" type="button">なし</button></div>
    <input class="tin fx-q" id="fxQ" type="search" enterkeyhint="search" autocomplete="off" maxlength="50" placeholder="Search KLIPY" aria-label="Search KLIPY" value="${esc(S.q)}">
    <div class="fx-list" id="fxList"><div class="fx-grid" id="fxGrid"></div><div class="fx-foot" id="fxFoot"></div></div>`;
  const q = $('#fxQ');
  q.oninput = () => { clearTimeout(qT); qT = setTimeout(() => search(q.value), 450); };
  q.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(qT); search(q.value); q.blur(); } };
  $('#fxNone').onclick = () => { setFx(null); paintCur(); paintGrid(); };
  $('#fxGrid').onclick = e => {
    const b = e.target.closest('[data-slug]'); if (!b) return;
    setFx(b.dataset.slug); klipy.shared(b.dataset.slug, S.q); paintCur(); paintGrid();
  };
  // 上（戻る・見出し・今の GIF・検索欄）は止めたまま、結果の一覧だけをスクロールする（下まで送ると次のページ）
  const list = $('#fxList');
  list.onscroll = () => { if (S.next && !S.busy && list.scrollTop + list.clientHeight > list.scrollHeight - 240) load(S.page + 1); };
  paintCur();
  if (S.items.length) paintGrid(); else search(S.q, true);
}

function search(text, force) {
  const q = String(text || '').trim().slice(0, 50);
  if (q === S.q && !force) return;
  S.q = q; S.items = []; S.page = 0; S.next = false;
  load(1);
}
async function load(page) {
  const seq = ++S.seq;
  S.busy = true; S.err = false; paintFoot();
  try {
    const r = await klipy.search(S.q, page);
    if (seq !== S.seq) return;
    S.items = page === 1 ? r.items : [...S.items, ...r.items]; S.page = page; S.next = r.next;
  } catch (e) {
    if (seq !== S.seq) return;
    S.err = true;
  }
  S.busy = false;
  if ($('#fxGrid')) { paintGrid(); paintFoot(); }
}

function paintGrid() {
  const g = $('#fxGrid'); if (!g) return;
  const cur = getFx();
  g.innerHTML = S.items.map(it => `<button class="fx-it" type="button" data-slug="${esc(it.slug)}" aria-pressed="${it.slug === cur}" aria-label="${esc(it.title || it.slug)}">${mediaHTML(it.thumb)}</button>`).join('');
}
function paintFoot() {
  const f = $('#fxFoot'); if (!f) return;
  f.innerHTML = S.busy ? '<span class="dots"><i></i><i></i><i></i></span>'
    : S.err ? '<span>読み込めませんでした</span><button class="btn ghost" id="fxRetry" type="button">もう一度</button>'
    : !S.items.length ? '<span>見つかりません</span>' : '';
  const r = $('#fxRetry'); if (r) r.onclick = () => load(S.page + 1);
}
async function paintCur() {
  const el = $('#fxCur'), slug = getFx(); if (!el) return;
  $('#fxNone').setAttribute('aria-pressed', String(!slug));
  if (!slug) { el.innerHTML = ''; el.classList.add('none'); return; }
  el.classList.remove('none');
  let it = S.items.find(x => x.slug === slug);
  if (!it) { try { it = (await klipy.lookup([slug])).get(slug); } catch (e) { it = null; } }
  if ($('#fxCur') !== el || getFx() !== slug) return;
  el.innerHTML = it ? mediaHTML(it.thumb, it.title) : '<span class="fx-empty">…</span>';
}
