// 開発専用（npm run dev → http://localhost:5180/?fake）：サーバー無し・ログイン無しで全画面を確かめるための代役。
// 本物の部屋のルール（server/game/rules.js）とエンジンをブラウザで動かす。ほかの参加者は簡単な Bot が演じる。
// net.js と同じものを export する：online, onSessionLost, currentUser, signIn, signOut, rpc, game。
// オプション（クエリ）：
//   &wait=ms  Bot が 1 人ずつ部屋に入ってくる間隔（既定 1500）
//   &idle     Bot が動かない（自分の持ち時間・離席を確かめる）
//   &fast     Bot の思考時間を短く
//   &chat=many  PRIVATE MATCH の卓で Bot がよく喋る（3〜6 秒に 1 回。上限ちょうどの長い文も混ぜる。見た目の確認用）
//   &allin    Bot がよくオールインする（ランアウトの演出の確認用）
//   &short    初期スタックを 2〜4 BB にする（すぐ終局する。再戦の確認用）
// 演出の確認（デモのメニューのボタン。create の demo）：部屋ごとの設定 R.show
//   river    4 人。自分 100BB・Bot 15BB。先に動く Bot がオールイン、ほかの Bot は降りる。配りは「プリフロップで両方オールインになったら、
//            ターンで 2 人に勝ちの目が残る」ものを選ぶ（半分はリバーで逆転）＝リバーの溜めの演出が毎回見られる
//   flow     3 人・普通の速さ（ベットの操作・街が変わるときの間）
//   rematch  3 人・2〜4BB ですぐ終わり、Bot は全員席に残る（席に残る → Rematch）
//   fx       4 人（PRIVATE MATCH）。river と同じ打ち方・スタックで、毎回ショーダウンになり勝者の演出 GIF が出る配りを選ぶ。
//            自分が GIF を設定していれば 7 割は自分が勝つ（自分の GIF）、残りと未設定なら Bot が勝つ（Bot は全員が見本の GIF を持つ）
import { createRoom, joinRoom, leaveRoom, applyRequest, tickRoom, viewsOf, postChat, MoveError, genCode, roomInfo, stayRoom, rematchRoom, rematchOpen, rematchLeader, setRoomFx } from '../server/game/rules.js';
import { legalActions, dueAt, handRecord, newTable, act, tick, fxSeat } from './engine.js';
import { equities } from './equity.js';
import { DEFAULT_CONFIG } from './structure.js';
import { CHAT_ROOM_MAX } from './chat.js';
import { DEMO_SLUGS } from './fxDemo.js';

const q = new URLSearchParams(location.search);
const WAIT = q.has('wait') ? Math.max(0, +q.get('wait') || 0) : 1500;
const IDLE = q.has('idle');
const THINK = q.has('fast') ? [200, 500] : [700, 2200];
const CHATTY = q.get('chat') === 'many';
const ALLIN = q.has('allin');
const SHORT = q.has('short');
const TALK = CHATTY ? [3000, 6000] : [20000, 40000];   // Bot の雑談の間隔
const ME = '00000000-0000-4000-8000-000000000001';
const NAMES = ['Mika', 'Kenta', 'Yui', 'Sora', 'Riku', 'Hana', 'Daichi', 'Emi', 'Taro', 'Nana'];

const me = { nickname: 'Satsuki' };
const rooms = new Map();          // id → { room, hands: [{rec, holes}], botAt, nextJoin, bots: Set, chat: [{seq, seat, text, at}], chatLast: [席ごとの最後の発言時刻], talk }
let botSeq = 2;
const lag = v => new Promise(r => setTimeout(() => r(structuredClone(v)), 80 + Math.random() * 100));
const botUid = () => `00000000-0000-4000-8000-${String(botSeq++).padStart(12, '0')}`;
const pickName = used => NAMES.find(n => !used.includes(n)) || 'Bot' + botSeq;
const fail = code => { const e = new Error(code); e.code = code; e.status = code === 'too_fast' ? 429 : 409; return e; };
const between = ([a, b]) => a + Math.random() * (b - a);
const pickOf = a => a[Math.floor(Math.random() * a.length)];
// PRIVATE MATCH の Bot の演出 GIF（4 人に 3 人。all なら全員。見本の slug。src/fxDemo.js）
const botFx = (room, all) => (room.kind === 'private' && (all || Math.random() < 0.75) ? pickOf(DEMO_SLUGS) : null);
// 配りを選び直す演出の確認（river / fx）
const rigged = show => show === 'river' || show === 'fx';
const newRoom = (room, show = null) => ({ room, hands: [], bots: new Set(), botAt: 0, nextJoin: Infinity, chat: [], chatLast: [], talk: null, stayAt: null, show, wait: show ? 250 : WAIT });
// &short（と演出の確認の rematch）：開始直後のスタックを 2〜4 BB に削る
function shorten(room, on = SHORT) {
  if (!on || !room.started) return room;
  const st = room.state, h = st.hand;
  st.players.forEach((p, s) => { if (p.stack > 0 && !h.allIn[s]) p.stack = Math.min(p.stack, h.bb * (2 + Math.floor(Math.random() * 3))); });
  h.startStacks = st.players.map((p, s) => p.stack + h.commits[s]);
  return room;
}

// FreeMatch の一覧に並べる、ほかの人が作った部屋
function seedFree() {
  for (const [players, n, speed, mode] of [[6, 3, 'normal', 'club'], [4, 1, 'slow', 'rank-4'], [3, 2, 'veryslow', 'legend-avg']]) {
    const id = crypto.randomUUID(), host = botUid();
    let room = createRoom({ id, code: genCode(Math.random), kind: 'free', uid: host, name: NAMES[Math.floor(Math.random() * NAMES.length)], config: { ...DEFAULT_CONFIG, players, speed, mode }, now: Date.now() - 60000 });
    for (let i = 1; i < n; i++) room = joinRoom(room, botUid(), NAMES[(i * 3) % NAMES.length], Date.now(), Math.random);
    rooms.set(id, { ...newRoom(room), bots: new Set(room.members) });
  }
}
seedFree();

function save(R, out) {
  R.room = out.room;
  if (out.record) { R.hands.push(out.record); bigPot(R, out.record.rec); }
}

// チャット（rules.js の postChat と同じ契約。DB の chat と同じく、先に postChat を通してから件数の上限を見る）
function pushChat(R, uid, text, now) {
  const seat = R.room.members.indexOf(uid);
  const out = postChat(R.room, uid, text, seat < 0 ? null : R.chatLast[seat] ?? null, now);
  if (R.chat.length >= CHAT_ROOM_MAX) throw new MoveError('chat_full');
  R.chatLast[out.seat] = now;
  const msg = { seq: R.chat.length + 1, seat: out.seat, text: out.text, at: now };
  R.chat.push(msg);
  return msg;
}
// Bot のおしゃべり（PRIVATE MATCH の卓だけ）：開始直後の挨拶、大きなポットのあと、ときどき独り言、終局の挨拶
const SAY = {
  hello: ['よろしく', 'よろしくお願いします', 'gl', 'gl hf', 'よろしく〜'],
  nice: ['nice', 'ナイスハンド！', 'nh', 'ナイス'],
  thanks: ['ty', 'ありがとう', 'いただきます'],
  idle: ['うーん', 'ここは降りる', '強気だね', 'gg', 'まじか', 'lol', 'wow', 'なるほど', '次こそ', 'きつい…', 'ブラフでしょ', 'hmm',
    '読まれてる気がする', 'そろそろ勝ちたい', 'いけると思ったのに', 'ブラインド上がるの早いね', 'ok'],
  bye: ['gg', 'gg wp', 'おつかれさまでした', 'ありがとうございました'],
  // ちょうど上限（CHAT_MAX_UNITS = 40）の文。?chat=many のときだけ
  long: ['リバーでそれを引かれたら本当にもう無理だ', 'さっきのオールインは完全にブラフでしょ！', 'that river was brutal, nice hand though!',
    'GG! 次はもっとうまくやるからね、覚えてて', 'ブラインドが上がる前にもう少し増やしたい', 'Folded the best hand again, unbelievable'],
};
const talkState = R => (R.talk ??= { at: Date.now() + between(TALK), queue: [], last: -1, hello: false, bye: false });
// 喋れる Bot の席（退出した Bot は喋らない。直前に喋った席と except は避ける）
function talkers(R, except = []) {
  const T = talkState(R), st = R.room.state;
  const all = R.room.members.map((u, s) => s).filter(s => R.bots.has(R.room.members[s]) && st.players[s].status !== 'left' && !except.includes(s));
  const fresh = all.filter(s => s !== T.last);
  return fresh.length ? fresh : all;
}
const shuffled = a => a.map(x => [Math.random(), x]).sort((x, y) => x[0] - y[0]).map(x => x[1]);
function say(R, seat, text, at) { talkState(R).queue.push({ seat, text, at }); }
function bigPot(R, rec) {
  if (R.room.kind !== 'private' || !R.bots.size) return;
  const pot = rec.won.reduce((a, b) => a + b, 0);
  if (pot < (CHATTY ? 10 : 30) * rec.bb || Math.random() > (CHATTY ? 0.9 : 0.4)) return;
  const winners = rec.won.map((w, s) => (w > 0 ? s : -1)).filter(s => s >= 0);
  const now = Date.now(), [who] = shuffled(talkers(R, winners));
  if (who != null) say(R, who, pickOf(SAY.nice), now + between([1200, 3000]));
  const w = winners.find(s => R.bots.has(R.room.members[s]));
  if (w != null && Math.random() < 0.3) say(R, w, pickOf(SAY.thanks), now + between([3500, 5500]));
}
function botTalk(R, now) {
  const room = R.room;
  if (room.kind !== 'private' || !room.started || !R.bots.size || room.status === 'cancelled') return;
  const T = talkState(R);
  if (!T.hello) {
    T.hello = true;
    shuffled(talkers(R)).slice(0, CHATTY ? 9 : 1 + Math.floor(Math.random() * 2)).forEach((s, i) => say(R, s, pickOf(SAY.hello), now + 1000 + i * 1500 + Math.random() * 1500));
  }
  if (room.status === 'finished' && !T.bye) {
    T.bye = true;
    shuffled(talkers(R)).slice(0, 1 + Math.floor(Math.random() * 2)).forEach((s, i) => say(R, s, pickOf(SAY.bye), now + 1500 + i * 1800 + Math.random() * 1000));
  }
  if (['running', 'paused'].includes(room.status) && now >= T.at && !T.queue.length) {
    const [s] = shuffled(talkers(R));
    if (s != null) say(R, s, CHATTY && Math.random() < 0.4 ? pickOf(SAY.long) : pickOf(SAY.idle), now);
    T.at = now + between(TALK);
  }
  T.queue.sort((a, b) => a.at - b.at);
  while (T.queue.length && T.queue[0].at <= now) {
    const m = T.queue.shift();
    try { pushChat(R, R.room.members[m.seat], m.text, now); T.last = m.seat; T.at = Math.max(T.at, now + between(TALK) * 0.75); }
    catch (e) { if (e.code === 'too_fast') { m.at = now + 1000; T.queue.push(m); break; } }
  }
}
// Bot：だいたいチェック/コール、ときどきレイズ、強く張られたら降りる
function botMove(view, seat, show) {
  const L = legalActions(view, seat), x = Math.random(), stack = view.players[seat].stack;
  if (!L) return null;
  if (rigged(show)) return riverMove(view, seat, L);
  if (show === 'rematch') return L.maxTo != null && x > 0.4 ? { type: 'allin' } : L.canCheck ? { type: 'check' } : { type: 'call' };   // 早く終わるように
  if (L.canFold && L.callPut > stack * 0.35 && x < 0.55) return { type: 'fold' };
  if (L.canFold && x < 0.12) return { type: 'fold' };
  if (L.minTo != null && x > 0.82) return { type: 'raise', to: Math.min(L.maxTo, L.minTo + Math.floor(Math.random() * 2) * view.hand.bb) };
  if (L.minTo != null && x > (ALLIN ? 0.5 : 0.985)) return { type: 'allin' };
  if (ALLIN && L.canFold) return { type: 'call' };
  return L.canCheck ? { type: 'check' } : { type: 'call' };
}
// 呼ばれるたびに時間で進むものを進める：Bot の入室・Bot の手番・時間切れ・次のハンド・Bot のおしゃべり
function advance(R) {
  advanceGame(R);
  botTalk(R, Date.now());
}
function advanceGame(R) {
  const now = Date.now();
  let room = R.room;
  if (!room.started && room.status === 'waiting' && room.members.includes(ME) && now >= R.nextJoin) {
    const uid = botUid(); R.bots.add(uid);
    save(R, { room: shorten(joinRoom(room, uid, pickName(room.names), now, Math.random, botFx(room, R.show === 'fx')), SHORT || R.show === 'rematch') });
    if (rigged(R.show) && R.room.started) rigFirst(R);
    R.nextJoin = now + R.wait;
    return advanceGame(R);
  }
  room = R.room;
  if (room.started && room.status === 'finished') return botsAfterGame(R, now);
  if (!room.started || !['running', 'paused'].includes(room.status)) return;
  for (let guard = 0; guard < 20; guard++) {
    const st = R.room.state, h = st.hand;
    if (st.status === 'running' && h && h.phase === 'betting' && R.bots.has(R.room.members[h.toAct]) && !IDLE && st.players[h.toAct].status === 'active') {
      const think = rigged(R.show) || R.show === 'rematch' ? [400, 1000] : THINK;   // 演出の確認は待たせない
      if (!R.botAt) R.botAt = now + think[0] + Math.random() * (think[1] - think[0]);
      if (now < R.botAt) return;
      R.botAt = 0;
      const seat = h.toAct, view = viewsOf(R.room)[seat], mv = botMove(view, seat, R.show);
      try { save(R, applyRequest(R.room, R.room.members[seat], { op: 'act', ver: R.room.ver, move: mv }, now)); }
      catch (e) { save(R, applyRequest(R.room, R.room.members[seat], { op: 'act', ver: R.room.ver, move: { type: legalActions(view, seat).canCheck ? 'check' : 'fold' } }, now)); }
      continue;
    }
    const at = dueAt(st);
    if (at == null || now < at + (h && h.phase === 'betting' ? 1500 : 0)) return;
    if (rigged(R.show) && h && h.phase === 'settled') rigNext(R.room.state, now);
    try { save(R, tickRoom(R.room, R.room.members.find(u => R.bots.has(u)) ?? ME, now)); } catch (e) { return; }
  }
}

/* ---------- 演出の確認：リバーまで勝負が残るオールイン（R.show = 'river'） ---------- */
// Bot：まだ誰もオールインしていなければオールイン、誰かがしていれば降りる（自分と 1 人の Bot の勝負にする）
function riverMove(view, seat, L) {
  const h = view.hand, shoved = h.allIn.some((a, s) => a && s !== seat && !h.folded[s]);
  if (shoved) return L.canFold ? { type: 'fold' } : { type: 'check' };
  if (L.maxTo != null) return { type: 'allin' };
  return L.canCheck ? { type: 'check' } : { type: 'call' };
}
// 配った直後の st を、Bot は riverMove・自分はコールで打ち切ったとき、ターンで 2 人以上に勝ちの目が残るか（flip なら、ターンで先行していた方がリバーで負ける）
function playOut(st, now, meSeat) {
  const c = structuredClone(st);
  for (let g = 0; g < 40 && c.status === 'running' && c.hand && c.hand.phase === 'betting'; g++) {
    const s = c.hand.toAct, L = legalActions(c, s);
    act(c, s, s === meSeat ? (L.canCheck ? { type: 'check' } : { type: 'call' }) : riverMove(c, s, L), now);
  }
  return c;
}
function tenseRunout(st, now, meSeat, flip) {
  const c = playOut(st, now, meSeat), h = c.hand;
  if (!h || !h.shown || h.runFrom !== 0 || !h.shown[meSeat]) return false;
  const pre = equities(h.shown, h.board.slice(0, 4)), alive = pre.filter(e => e > 0);
  if (alive.length < 2 || alive.every(e => Math.abs(e - alive[0]) < 1e-9)) return false;
  if (!flip) return true;
  const lead = pre.indexOf(Math.max(...pre));
  return !h.pots[0].winners.includes(lead);
}
// 演出 GIF の確認（R.show = 'fx'）：同じ打ち方で、自分も入ったショーダウンになり勝者の GIF が出るか（wantMe：true = 自分が勝つ / false = Bot / null = どちらでも）
function fxRunout(st, now, meSeat, wantMe) {
  const h = playOut(st, now, meSeat).hand;
  if (!h || h.phase !== 'settled' || !h.shown || !h.shown[meSeat]) return false;
  const fs = fxSeat(h, st.fx);
  return fs != null && (wantMe == null || (fs === meSeat) === wantMe);
}
// 選び直す配りの条件（i = 何回目か。300 回で見つからなければ条件をゆるめる）
function rigCheck(R, meSeat) {
  if (R.show === 'fx') {
    const mine = !!(R.room.state.fx && R.room.state.fx[meSeat]), wantMe = mine && Math.random() < 0.7;
    return (c, now, i) => fxRunout(c, now, meSeat, i < 300 ? wantMe : null);
  }
  const flip = Math.random() < 0.5;
  return (c, now, i) => tenseRunout(c, now, meSeat, flip && i < 300);
}
// 自分 100BB・Bot 15BB にして、最初のハンドを勝負が残る（fx なら勝者の GIF が出る）配りにする
function rigFirst(R) {
  const r0 = R.room, meSeat = r0.members.indexOf(ME), good = rigCheck(R, meSeat);
  const stacks = r0.members.map(u => (u === ME ? 100 : 15) * r0.state.hand.bb);
  for (let i = 0; i < 400; i++) {
    const st = newTable({ config: r0.config, names: r0.names, now: r0.state.startedAt, stacks, fx: r0.state.fx });
    if (i === 399 || good(st, r0.state.startedAt, i)) { R.room = { ...r0, state: st }; return; }
  }
}
// 次のハンドの配りを、勝負が残るものにする（乱数の鍵を選び直す。デモだけ）
function rigNext(st, now) {
  const R = [...rooms.values()].find(x => x.room.state === st), meSeat = R.room.members.indexOf(ME), good = rigCheck(R, meSeat);
  if (st.players[meSeat].status === 'out') return;
  for (let i = 0; i < 400; i++) {
    const seed = Array.from(crypto.getRandomValues(new Uint32Array(8))), c = structuredClone(st);
    c.seed = seed; c.ctr = 0;
    try { tick(c, Math.max(now, st.nextAt)); } catch (e) { return; }
    if (c.status !== 'running' || !c.hand) return;
    if (good(c, now, i)) { st.seed = seed; st.ctr = 0; return; }
  }
}
// 終局後の Bot：7 割が席に残り、残りは去る。再戦を始める役が Bot なら、自分（ME）が残ってから少しして始める
function botsAfterGame(R, now) {
  const room = R.room; if (!rematchOpen(room, now)) return;
  R.stayAt ??= room.members.map(u => (R.bots.has(u) && room.state.players[room.members.indexOf(u)].status !== 'left' ? now + between([1200, 5000]) : null));
  room.members.forEach((u, s) => {
    if (R.stayAt[s] == null || now < R.stayAt[s]) return;
    R.stayAt[s] = null;
    try { save(R, Math.random() < (R.show ? 1 : 0.7) ? stayRoom(R.room, u, now) : leaveRoom(R.room, u, now)); } catch (e) { /* 受付終了 */ }
  });
  const rm = viewsOf(R.room)[0].rematch, lead = rematchLeader(rm, R.room.state.endedAt, now), meSeat = R.room.members.indexOf(ME);
  if (lead == null || !R.bots.has(R.room.members[lead]) || !rm.stay.includes(meSeat) || !rm.stay.includes(lead)) return;
  R.rematchAt ??= now + 2500;
  if (now >= R.rematchAt) startRematch(R, R.room.members[lead], now);
}
function startRematch(R, uid, now, fx) {
  const names = new Map(R.room.members.map((u, s) => [u, u === ME ? me.nickname : R.room.names[s]]));
  const out = rematchRoom(R.room, uid, { id: crypto.randomUUID(), code: genCode(Math.random), names, fx }, now, Math.random);
  save(R, { room: out.room });
  const N = { ...newRoom(shorten(out.next, SHORT || R.show === 'rematch'), R.show), bots: new Set(out.next.members.filter(u => R.bots.has(u))) };
  rooms.set(N.room.id, N);
  if (rigged(N.show)) rigFirst(N);
  return N;
}
const mine = () => [...rooms.values()].find(R => ['waiting', 'running', 'paused'].includes(R.room.status) && R.room.members.includes(ME) &&
  (!R.room.started || !['out', 'left'].includes(R.room.state.players[R.room.members.indexOf(ME)].status)));
const replyOf = R => { const pos = R.room.members.indexOf(ME); const vs = viewsOf(R.room); return { room: R.room.id, ver: R.room.ver, now: Date.now(), view: pos < 0 ? null : R.room.started ? vs[pos] : vs[0] }; };

export const online = true;
export const onSessionLost = () => {};
export async function currentUser() { return { id: ME }; }
export async function signIn() {}
export async function signOut() {}

export async function rpc(name, args = {}) {
  for (const R of rooms.values()) advance(R);
  switch (name) {
    case 'me': {
      const R = mine();
      const recent = [...rooms.values()].filter(x => x.room.started && x.room.members.includes(ME)).map(x => ({ id: x.room.id, endedAt: x.room.state.endedAt }));
      return lag({ nickname: me.nickname, room: R ? { id: R.room.id, code: R.room.code, kind: R.room.kind, status: R.room.status, started: R.room.started } : null, recent });
    }
    case 'set_nickname': {
      const v = String(args.p_name || '').trim();
      if (v.length < 1 || v.length > 16) throw fail('nickname_invalid');
      me.nickname = v; return lag({ nickname: v });
    }
    case 'room_poll': {
      const R = rooms.get(args.p_room); if (!R || !R.room.members.includes(ME)) throw fail('not_found');
      const r = replyOf(R);
      return lag({ ver: r.ver, now: r.now, view: r.ver > (args.p_ver ?? -1) ? { ...r.view, status: R.room.status } : null, chat: R.chat.length });
    }
    case 'room_chat': {
      const R = rooms.get(args.p_room); if (!R || !R.room.members.includes(ME)) throw fail('not_found');
      if (R.room.kind !== 'private') return lag([]);
      return lag(R.chat.filter(m => m.seq > (args.p_after || 0)).slice(-200));
    }
    case 'room_peek': {
      const R = [...rooms.values()].filter(x => x.room.code === args.p_code).sort((a, b) => b.room.createdAt - a.room.createdAt)[0];
      if (!R) return lag(null);
      const x = R.room;
      return lag({ id: x.id, code: x.code, kind: x.kind, status: x.status, config: x.config, host: x.names[x.members.indexOf(x.host)] ?? x.names[0], seated: x.members.length, member: x.members.includes(ME) });
    }
    case 'free_rooms':
      return lag([...rooms.values()].filter(R => R.room.kind === 'free' && R.room.status === 'waiting' && !R.room.members.includes(ME))
        .map(R => ({ id: R.room.id, code: R.room.code, host: R.room.names[0], seated: R.room.members.length, config: R.room.config, createdAt: R.room.createdAt })));
    case 'room_hands': {
      const R = rooms.get(args.p_room); if (!R || !R.room.started) throw fail('not_found');
      const seat = R.room.members.indexOf(ME);
      return lag(R.hands.filter(h => h.rec.handNo > (args.p_after || 0)).slice(0, 200).map(h => ({ ...h.rec, hole: h.holes[seat] })));
    }
    default: throw fail('not_found');
  }
}

export async function game(body) {
  for (const R of rooms.values()) advance(R);
  const now = Date.now();
  try {
    switch (body.op) {
      case 'create': {
        const SHOWS = { river: { players: 4, startBb: 100 }, flow: { players: 3, startBb: 100 }, rematch: { players: 3, startBb: 50 }, fx: { players: 4, startBb: 100 } };
        const show = SHOWS[body.demo] ? body.demo : null;
        let cur = mine();
        if (cur && show) { try { save(cur, leaveRoom(cur.room, ME, now)); } catch (e) { /* もう無い */ } cur = mine(); }   // 演出の確認はいまの卓を抜けてから
        if (cur) throw new MoveError('in_other_room', { room: cur.room.id });
        const id = crypto.randomUUID();
        const config = show ? { ...DEFAULT_CONFIG, ...SHOWS[show] } : body.config;
        const room = createRoom({ id, code: genCode(Math.random), kind: body.kind, uid: ME, name: me.nickname, config, now, fx: body.fx });
        const R = { ...newRoom(room, show), nextJoin: now + (show ? 400 : WAIT * 2) };
        rooms.set(id, R);
        return lag(replyOf(R));
      }
      case 'join': {
        const R = [...rooms.values()].find(x => x.room.code === body.code && ['waiting', 'running', 'paused'].includes(x.room.status));
        if (!R) throw new MoveError('not_found');
        if (!R.room.members.includes(ME)) {
          const cur = mine(); if (cur) throw new MoveError('in_other_room', { room: cur.room.id });
          save(R, { room: shorten(joinRoom(R.room, ME, me.nickname, now, Math.random, body.fx), SHORT || R.show === 'rematch') });
          R.nextJoin = now + WAIT;
        }
        return lag(replyOf(R));
      }
      case 'leave': { const R = rooms.get(body.room); if (!R) throw new MoveError('not_found'); save(R, leaveRoom(R.room, ME, now)); return lag(replyOf(R)); }
      case 'fx': { const R = rooms.get(body.room); if (!R) throw new MoveError('not_found'); save(R, setRoomFx(R.room, ME, body.fx ?? null)); return lag(replyOf(R)); }
      case 'stay': { const R = rooms.get(body.room); if (!R) throw new MoveError('not_found'); save(R, stayRoom(R.room, ME, now, body.fx)); return lag(replyOf(R)); }
      case 'rematch': {
        const R = rooms.get(body.room); if (!R) throw new MoveError('not_found');
        return lag(replyOf(startRematch(R, ME, now, body.fx)));
      }
      case 'act': case 'sitin': case 'sitout': {
        const R = rooms.get(body.room); if (!R) throw new MoveError('not_found');
        save(R, applyRequest(R.room, ME, body.op === 'act' ? { op: 'act', ver: body.ver, move: body.move } : { op: body.op }, now));
        return lag(replyOf(R));
      }
      case 'tick': {
        const R = rooms.get(body.room); if (!R) throw new MoveError('not_found');
        const v0 = R.room.ver; advance(R);
        if (R.room.ver === v0) save(R, tickRoom(R.room, ME, now));
        return lag(replyOf(R));
      }
      case 'chat': {
        const R = rooms.get(body.room); if (!R) throw new MoveError('not_found');
        if (typeof body.text !== 'string') throw new MoveError('malformed');
        const msg = pushChat(R, ME, body.text, now);
        return lag({ now: Date.now(), msg });
      }
      default: throw new MoveError('malformed');
    }
  } catch (e) {
    if (e instanceof MoveError) { const x = fail(e.code); x.data = { error: e.code, ...(e.extra || {}) }; throw x; }
    throw e;
  }
}
// 開発中の確認用
window.__fake = { rooms, roomInfo, handRecord };
