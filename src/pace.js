// 卓の画面の遷移の間（ms）と、2 つのビューの間の遷移を見せる順番（純関数。src/ui/table.js が使い、test/pace.test.js が確かめる）。
// サーバーのビューは状態を一度に運んでくる（相手が 2 人続けて動いた・コールでストリートが変わった・フォールドで終わった）ので、
// 画面ではそれを 1 拍ずつ見せ、見せ終わるまで次のビューを当てない（遷移を重ねない）。
//
// 間の根拠（docs/ARCHITECTURE.md §8）
//   beat 550   連続する出来事の最小の間。2 つ目が 200〜500ms 以内だと見落とす（attentional blink, Raymond 1992）のを越え、
//              人が自然に感じるテンポ（500〜650ms）の 1 拍
//   pop 220    チップ・アクションの札が出る動き（1 つの動きは 200〜400ms。Material のモバイル 225〜300ms、NN/g 100〜500ms）
//   show 300 / gather 612 / gap 160   ストリートの終わり：最後のベットを見せる → ポットへ集める → 一呼吸（別の出来事として見せる）
//   flip 260 / flipStagger 110        ターン・リバーの札を返す 1 枚 200〜300ms、刻みは知覚の 1 サイクル（≈100ms）より長く、1 枚ずつ認識できる
//   flopFlip 468 / flopStagger 198    フロップ（3 枚まとめて）は 1.8 倍ゆっくり返す
//   deal 360 / dealStagger 144        配る 1 枚と刻み。6 人で約 1.9 秒
//   chip 1170 / win 1290              ポットから勝者へチップが飛ぶ長さ（飛び始めは 120ms 後）と、フォールドで終わったときに次のビューを待つ長さ
//   ※ 配る・チップが動く（gather / chip）・フロップは、実際に遊んで速すぎるという声で 1.8 倍にした（2026-10。もとは gather 340・deal 200/80・
//     チップ 650・フロップ 260/110。1 つの動きは 200〜400ms という目安より長いが、知り合いと眺めながら打つ卓では落ち着いて見える方を取る）
//   controlsIn 250 / lock 400         （controlsIn は今は使わない：ドックの形を変えず、ボタンも浮かせない）出てから押せるまで（誤タップ防止。Chrome は許可ダイアログのボタンを 500ms 無効化）。
//                                     出来事から押せるまでの合計は 1 秒以内（Nielsen の 1 秒）
//   sheetIn 240 / sheetOut 200        パネルを開く・閉じる（出る方を長く）
//   maxLag 3000                       これ以上遅れたら途中を飛ばして最新を出す（サーバーの持ち時間を削りすぎない）
export const PACE = {
  beat: 550, pop: 220, show: 300, gather: 612, gap: 160, flip: 260, flipStagger: 110, flopFlip: 468, flopStagger: 198, deal: 360, dealStagger: 144,
  controlsIn: 250, lock: 400, sheetIn: 240, sheetOut: 200, chip: 1170, win: 1290, maxLag: 3000,
};
/** 街の札を返す速さ（from = 返す前のボードの枚数）。フロップを含むときは 1.8 倍ゆっくり、ターン・リバーはそのまま */
export const flipOf = (from, P = PACE) => (from < 3 ? { ms: P.flopFlip, stagger: P.flopStagger } : { ms: P.flip, stagger: P.flipStagger });

const quiet = a => a.kind === 'fold' || a.kind === 'check';

/** その街の最後のベット：prev の streetBet に、その街で新しく入ったアクションの「〜まで」を重ねる（コールで街が閉じても最後のチップを見せるため） */
export function closingBets(a, b) {
  const bets = a.streetBet.slice();
  for (const x of b.actions.slice(a.actions.length)) if (x.street === a.street && !quiet(x)) bets[x.seat] = x.betTo;
  return bets;
}

/**
 * 前に見せたビュー prev から次のビュー v への遷移の種類。
 *   init（初めて・席が変わった）/ none（見た目が進まない：離席・時間切れの手前など）/ deal（新しいハンド）
 *   / action（同じ街でアクションが増えた）/ street（街が進んだ）/ win（フォールドで終わった）/ showdown（ショーダウン）
 */
export function transition(prev, v) {
  const a = prev && prev.hand, b = v && v.hand;
  if (!a || !b || prev.seat !== v.seat) return { kind: 'init' };
  if (b.handNo !== a.handNo) return { kind: 'deal' };
  if (a.phase === 'settled') return { kind: 'none' };
  const fresh = b.actions.slice(a.actions.length);
  if (b.phase === 'settled') return { kind: b.shown && b.runFrom != null ? 'showdown' : 'win', fresh, closing: closingBets(a, b), boardFrom: a.board.length };
  if (b.street > a.street) return { kind: 'street', fresh, closing: closingBets(a, b), boardFrom: a.board.length, boardTo: b.board.length };
  if (fresh.length) return { kind: 'action', fresh };
  return { kind: 'none' };
}

/**
 * 遷移の見せ方（時刻は v を当てた瞬間からの ms）。
 *   steps:    [{ at, bets, shown, street, adj }]  前の街のアクションを 1 拍ずつ。bets = その時点で見せるベット、shown = 見せるアクションの数、
 *             adj = スタックに足す分（まだ見せていないベット）
 *   board:    revealAt まで見せるボードの枚数（null は v のまま）
 *   gatherAt: ベットをポットへ集める時刻 / revealAt: 新しい札（街）・結果を見せる時刻 / runoutAt: ショーダウンの演出を始める時刻
 *   turnAt:   手番の合図と操作ボタンを出す時刻 / end: この遷移の動きが終わる時刻
 *   hold:     次のビューを当ててよいまでの時間（ショーダウンは演出の長さを table.js が足す）
 *   veil:     revealAt（または runoutAt）まで結果を伏せる
 *   bets0 / shown0 / street0: steps が無いときに最初に見せるベット・アクションの数・街（null は v のまま）
 */
export function plan(prev, v, P = PACE) {
  const tr = transition(prev, v);
  const out = { kind: tr.kind, steps: [], board: null, gatherAt: null, revealAt: null, runoutAt: null, turnAt: 0, end: 0, hold: 0, veil: false, bets0: null, shown0: null, street0: null };
  if (tr.kind === 'init' || tr.kind === 'none') return out;
  const a = prev.hand, b = v.hand;
  if (tr.kind === 'deal') {
    const cards = b.startStacks.filter(x => x > 0).length * 2;
    out.end = out.turnAt = P.deal + Math.max(0, cards - 1) * P.dealStagger;
    out.hold = Math.max(out.end, P.beat);
    // ブラインドだけでオールインになり、配った時点で精算済み：配り終えてからショーダウン
    if (b.phase === 'settled' && b.shown && b.runFrom != null) { out.kind = 'deal-showdown'; out.runoutAt = out.end; out.veil = true; out.board = Math.min(b.runFrom, b.board.length); }
    return out;
  }
  // 前の街のアクションを 1 拍ずつ（同じ街のものだけ。ビューが街を 2 つ飛ばしたら、その間は飛ばす）
  const mine = tr.fresh.filter(x => x.street === a.street), final = tr.kind === 'action' ? b.streetBet : tr.closing;
  let bets = a.streetBet.slice();
  mine.forEach((x, i) => {
    if (!quiet(x)) { bets = bets.slice(); bets[x.seat] = x.betTo; }
    out.steps.push({ at: i * P.beat, bets, shown: a.actions.length + i + 1, street: a.street, adj: final.map((f, s) => Math.max(0, f - bets[s])) });
  });
  const last = mine.length ? (mine.length - 1) * P.beat : 0, base = mine.length ? last + P.pop : 0;
  if (tr.kind === 'action') {
    out.end = base;
    out.turnAt = mine.length ? last + P.beat : 0;
    out.hold = out.turnAt;
    return out;
  }
  out.gatherAt = base + P.show;
  out.board = tr.boardFrom;
  if (!mine.length) { out.bets0 = tr.closing; out.shown0 = a.actions.length; out.street0 = a.street; }
  if (tr.kind === 'street') {
    const n = Math.max(1, tr.boardTo - tr.boardFrom), f = flipOf(tr.boardFrom, P);
    out.revealAt = out.gatherAt + P.gather + P.gap;
    out.end = out.revealAt + f.ms + (n - 1) * f.stagger;
    out.turnAt = out.end;
    out.hold = Math.max(out.end, out.revealAt + P.beat);
    return out;
  }
  out.veil = true;
  if (tr.kind === 'win') {
    out.revealAt = out.gatherAt + P.gather + P.gap;
    out.end = out.turnAt = out.revealAt;
    out.hold = out.revealAt + P.win;
    return out;
  }
  // showdown：最後のベットを見せてから、演出（ベットを集めるところから）へ
  out.gatherAt = null;
  out.runoutAt = base + P.show;
  out.end = out.turnAt = out.runoutAt;
  out.hold = out.runoutAt;
  return out;
}

/** 受け取ったビューの列を、当ててよい時刻に当てる順番を決める（table.js の pump の判断を純関数にしたもの）。
 *  queue = [{ v, at（受け取った時刻）}]、holdUntil = 前の遷移が終わる時刻 → { take: 当てる要素 | null, skip: 飛ばした数, wait: 待つ ms } */
export function nextToApply(queue, holdUntil, now, P = PACE) {
  if (!queue.length) return { take: null, skip: 0, wait: 0 };
  const late = now - queue[0].at >= P.maxLag;
  if (late) return { take: queue[queue.length - 1], skip: queue.length - 1, wait: 0, late: true };
  if (now < holdUntil) return { take: null, skip: 0, wait: holdUntil - now };
  return { take: queue[0], skip: 0, wait: 0 };
}
