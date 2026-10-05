// ハンドの記録（engine.handRecord の rec）を読む純関数：拠出額・収支・ポジション名・ストリートごとのポット。履歴の画面と集計で使う。

/** アンティ・ブラインドの拠出（席順）。記録には拠出額そのものは無いので、開始スタックとブラインドから復元する */
export function forcedOf(rec) {
  const n = rec.startStacks.length, out = Array(n).fill(0);
  const live = s => rec.startStacks[s] > 0;
  if (rec.ante > 0) for (let s = 0; s < n; s++) if (live(s)) out[s] += Math.min(rec.startStacks[s], rec.ante);
  if (rec.sbSeat != null) out[rec.sbSeat] += Math.min(rec.startStacks[rec.sbSeat] - out[rec.sbSeat], rec.sb);
  out[rec.bbSeat] += Math.min(rec.startStacks[rec.bbSeat] - out[rec.bbSeat], rec.bb);
  return out;
}
/** その席がこのハンドで出した合計 */
export function committedOf(rec, seat) {
  return forcedOf(rec)[seat] + rec.actions.filter(a => a.seat === seat).reduce((x, a) => x + a.put, 0);
}
/** その席の収支（チップ） */
export const netOfRecord = (rec, seat) => (rec.won[seat] ?? 0) - committedOf(rec, seat);

/** ストリート開始時のポット（アンティ・ブラインド込み）。index 0 = プリフロップ */
export function streetPots(rec) {
  const forced = forcedOf(rec).reduce((a, b) => a + b, 0), out = [];
  for (let st = 0; st < 4; st++) {
    out.push(forced + rec.actions.filter(a => a.street < st).reduce((x, a) => x + a.put, 0));
  }
  return out;
}

// 生存人数ごとのポジション名（末尾が BB）
const POS = { 2: ['SB', 'BB'], 3: ['BTN', 'SB', 'BB'], 4: ['CO', 'BTN', 'SB', 'BB'], 5: ['HJ', 'CO', 'BTN', 'SB', 'BB'], 6: ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'], 7: ['UTG', 'UTG+1', 'HJ', 'CO', 'BTN', 'SB', 'BB'] };
/** 席 → ポジション名（このハンドに参加していない席は null）。デッド SB のハンドは枠を 1 つ多く数えて SB を抜く */
export function positionsOf(rec) {
  const n = rec.startStacks.length, live = [];
  for (let s = 0; s < n; s++) if (rec.startStacks[s] > 0) live.push(s);
  const k = live.indexOf(rec.bbSeat);
  const order = k < 0 ? live : [...live.slice(k + 1), ...live.slice(0, k + 1)];
  const names = rec.sbSeat == null && live.length > 2 ? POS[live.length + 1].filter(p => p !== 'SB') : POS[live.length].slice();
  const out = Array(n).fill(null);
  order.forEach((s, i) => { out[s] = names[i] ?? null; });
  return out;
}

export const STREET_NAMES = ['Preflop', 'Flop', 'Turn', 'River'];
const KIND = { fold: 'Fold', check: 'Check', call: 'Call', bet: 'Bet', raise: 'Raise', allin: 'All-in' };
/** アクションの表示（「Raise 600」「Call 200」など。金額はそのストリートの「〜まで」） */
export function actionText(a) {
  const k = KIND[a.kind] || a.kind;
  if (a.kind === 'fold' || a.kind === 'check') return k;
  return `${k} ${a.kind === 'call' ? a.put : a.betTo}`;
}
