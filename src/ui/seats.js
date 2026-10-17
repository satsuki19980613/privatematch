// 卓の人数の選択（すべて / 2〜6 人）と、人数ごとの順位の表。メニューの STATS と FRIEND MATCH の STATS で同じものを使う。
// 順位は人数の違う卓どうしでは比べられないので、すべてのときは人数ごとの表（行 = 人数。色の濃さはその人数での割合）にする。
import { ALL, seatsLabel, parseSeats } from '../history/stats.js';
import { fmtNum, fmtRate } from '../friend.js';

const EMPTY = '<div class="empty-note">まだ記録がありません。</div>';
const td = html => '<td>' + html + '</td>';
const th = html => '<th>' + html + '</th>';

const seatsBtnHTML = (p, cur) => `<button type="button" data-seats="${p}" aria-pressed="${cur === p}">${seatsLabel(p)}</button>`;
/** 人数の選択（list = 打たれた人数。無ければ出さない）。cur = 選んでいる人数 | ALL */
export function seatsSegHTML(list, cur) {
  if (!list.length) return '';
  const btns = [ALL, ...list].map(p => seatsBtnHTML(p, cur)).join('');
  return `<div class="seg fr-seats" role="group" aria-label="卓の人数">${btns}</div>`;
}
/** 人数を選んだら onPick(人数 | ALL) */
export function bindSeatsSeg(el, onPick) {
  el.querySelectorAll('[data-seats]').forEach(b => b.onclick = () => onPick(parseSeats(b.dataset.seats)));
}

/** 人数ごとの順位の表（list = [{ p, n, dist, avgPlace, firstRate }]）。hi = 強調する人数 */
export function placeTableHTML(list, hi = ALL) {
  if (!list.length) return EMPTY;
  const places = Array.from({ length: Math.max(...list.map(r => r.p)) }, (_, i) => i);
  const cell = (r, i) => (i < r.p ? `<td class="pm-c" style="--h:${(r.dist[i] / r.n).toFixed(3)}">${r.dist[i]}</td>` : '<td></td>');
  const row = r => `<tr${r.p === hi ? ' class="hi"' : ''}>${td(seatsLabel(r.p))}${td(String(r.n))}${places.map(i => cell(r, i)).join('')}${td(fmtNum(r.avgPlace))}${td(fmtRate(r.firstRate))}</tr>`;
  const head = th('人数') + th('戦') + places.map(i => `<th class="pm-h">${i + 1}位</th>`).join('') + th('平均') + th('1位率');
  return `<div class="tbl-scroll"><table class="tbl fr-tbl pm-tbl"><thead><tr>${head}</tr></thead><tbody>${list.map(row).join('')}</tbody></table></div>`;
}
