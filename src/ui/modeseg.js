// ゲームモードの選択（種類 → クラブ以外は段階）。STATS と FRIEND MATCH のスタッツ・ランキングで同じものを使う。
import { GAME_KINDS, GAME_KIND_LABELS, MODES_BY_KIND, GAME_MODES } from '../structure.js';

const variantLabel = m => (GAME_MODES[m].kind === 'rank' ? 'STAGE ' + GAME_MODES[m].variant : GAME_MODES[m].variant);

const btnHTML = (value, label, on) => `<button type="button" data-v="${value}" aria-pressed="${on}">${label}</button>`;

export function modeSegHTML(mode) {
  const kind = GAME_MODES[mode].kind, variants = MODES_BY_KIND[kind];
  const kinds = '<div class="seg hs-mode" data-key="kind">' + GAME_KINDS.map(k => btnHTML(k, GAME_KIND_LABELS[k], kind === k)).join('') + '</div>';
  if (variants.length <= 1) return kinds;
  return kinds + '<div class="seg hs-mode hs-var" data-key="mode">' + variants.map(m => btnHTML(m, variantLabel(m), mode === m)).join('') + '</div>';
}
/** 選択のボタンを押したら onPick(新しいモード)。種類を変えたらその先頭の段階、同じ種類ならそのまま */
export function bindModeSeg(el, getMode, onPick) {
  el.querySelectorAll('.hs-mode').forEach(sg => sg.onclick = e => {
    const b = e.target.closest('[data-v]'); if (!b) return;
    const mode = getMode();
    if (sg.dataset.key !== 'kind') return onPick(b.dataset.v);
    onPick(GAME_MODES[mode].kind === b.dataset.v ? mode : MODES_BY_KIND[b.dataset.v][0]);
  });
}
