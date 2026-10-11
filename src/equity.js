// ショーダウンの演出で出す勝率と、勝った 5 枚。卓の画面（src/ui/table.js）が使う。ルールは engine.js の eval7 だけを使う。
import { eval7 } from './engine.js';

// 決まった種の乱数（どの端末でも同じ勝率を出すため）
function mulberry32(a) {
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * 勝率（メインポットの取り分の期待値。引き分けは等分）。holes は席ごとの [c, c] か null（対象外）、board は 0〜5 枚。
 * 残りが 2 枚以下なら全通り、3 枚以上なら種 seed の乱数で samples 回。=> 席ごとの 0..1（対象外は 0）
 */
export function equities(holes, board, { samples = 40000, seed = 1 } = {}) {
  const seats = []; for (let s = 0; s < holes.length; s++) if (holes[s]) seats.push(s);
  const used = new Set(board); for (const s of seats) for (const c of holes[s]) used.add(c);
  const deck = []; for (let c = 0; c < 52; c++) if (!used.has(c)) deck.push(c);
  const base = seats.map(s => [...holes[s], ...board]);
  const eq = new Array(holes.length).fill(0), k = 5 - board.length;
  let total = 0;
  const run = extra => {
    let best = -1, win = 0, ties = [];
    for (let i = 0; i < seats.length; i++) {
      const sc = eval7(extra.length ? base[i].concat(extra) : base[i]);
      if (sc > best) { best = sc; win = 1; ties[0] = i; } else if (sc === best) ties[win++] = i;
    }
    for (let j = 0; j < win; j++) eq[seats[ties[j]]] += 1 / win;
    total++;
  };
  if (k <= 0) run([]);
  else if (k === 1) for (const a of deck) run([a]);
  else if (k === 2) { for (let i = 0; i < deck.length; i++) for (let j = i + 1; j < deck.length; j++) run([deck[i], deck[j]]); }
  else {
    const rnd = mulberry32(seed), d = deck.slice(), out = new Array(k);
    for (let n = 0; n < samples; n++) {
      for (let i = 0; i < k; i++) { const j = i + Math.floor(rnd() * (d.length - i)); const t = d[i]; d[i] = d[j]; d[j] = t; out[i] = d[i]; }
      run(out);
    }
  }
  return eq.map(x => x / total);
}

/** 表示用の %（0 と 100 は本当にそうなときだけ） */
export function pctOf(x) {
  const p = Math.round(x * 100);
  return p === 0 && x > 0 ? 1 : p === 100 && x < 1 ? 99 : p;
}

/** 7 枚（2〜7 枚）のうち役を作る 5 枚（5 枚未満ならそのまま） */
export function bestFive(cards) {
  if (cards.length <= 5) return cards.slice();
  const full = eval7(cards), pick = [];
  const go = from => {
    if (pick.length === 5) return eval7(pick.map(i => cards[i])) === full;
    for (let i = from; i <= cards.length - (5 - pick.length); i++) { pick.push(i); if (go(i + 1)) { return true; } pick.pop(); }
    return false;
  };
  return go(0) ? pick.map(i => cards[i]) : cards.slice(0, 5);
}
