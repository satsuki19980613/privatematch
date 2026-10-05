// 開発専用（npm run dev → http://localhost:5180/?fake）：サーバー無し・ログイン無しで全画面を確かめるための代役。
// 本物の部屋のルール（server/game/rules.js）とエンジンをブラウザで動かす。ほかの参加者は簡単な Bot が演じる。
// net.js と同じものを export する：online, onSessionLost, currentUser, signIn, signOut, rpc, game。
// オプション（クエリ）：
//   &wait=ms  Bot が 1 人ずつ部屋に入ってくる間隔（既定 1500）
//   &idle     Bot が動かない（自分の持ち時間・離席を確かめる）
//   &fast     Bot の思考時間を短く
import { createRoom, joinRoom, leaveRoom, applyRequest, tickRoom, viewsOf, MoveError, genCode, roomInfo } from '../server/game/rules.js';
import { legalActions, dueAt, handRecord } from './engine.js';
import { DEFAULT_CONFIG } from './structure.js';

const q = new URLSearchParams(location.search);
const WAIT = q.has('wait') ? Math.max(0, +q.get('wait') || 0) : 1500;
const IDLE = q.has('idle');
const THINK = q.has('fast') ? [200, 500] : [700, 2200];
const ME = '00000000-0000-4000-8000-000000000001';
const NAMES = ['Mika', 'Kenta', 'Yui', 'Sora', 'Riku', 'Hana', 'Daichi', 'Emi', 'Taro', 'Nana'];

const me = { nickname: 'Satsuki' };
const rooms = new Map();          // id → { room, hands: [{rec, holes}], botAt, nextJoin, bots: Set }
let botSeq = 2;
const lag = v => new Promise(r => setTimeout(() => r(structuredClone(v)), 80 + Math.random() * 100));
const botUid = () => `00000000-0000-4000-8000-${String(botSeq++).padStart(12, '0')}`;
const pickName = used => NAMES.find(n => !used.includes(n)) || 'Bot' + botSeq;
const fail = code => { const e = new Error(code); e.code = code; e.status = 409; return e; };

// FreeMatch の一覧に並べる、ほかの人が作った部屋
function seedFree() {
  for (const [players, n, speed, mode] of [[6, 3, 'normal', 'club'], [4, 1, 'slow', 'rank-4'], [3, 2, 'veryslow', 'legend-avg']]) {
    const id = crypto.randomUUID(), host = botUid();
    let room = createRoom({ id, code: genCode(Math.random), kind: 'free', uid: host, name: NAMES[Math.floor(Math.random() * NAMES.length)], config: { ...DEFAULT_CONFIG, players, speed, mode }, now: Date.now() - 60000 });
    for (let i = 1; i < n; i++) room = joinRoom(room, botUid(), NAMES[(i * 3) % NAMES.length], Date.now(), Math.random);
    rooms.set(id, { room, hands: [], bots: new Set(room.members), botAt: 0, nextJoin: Infinity });
  }
}
seedFree();

function save(R, out) {
  R.room = out.room;
  if (out.record) R.hands.push(out.record);
}
// Bot：だいたいチェック/コール、ときどきレイズ、強く張られたら降りる
function botMove(view, seat) {
  const L = legalActions(view, seat), x = Math.random(), stack = view.players[seat].stack;
  if (!L) return null;
  if (L.canFold && L.callPut > stack * 0.35 && x < 0.55) return { type: 'fold' };
  if (L.canFold && x < 0.12) return { type: 'fold' };
  if (L.minTo != null && x > 0.82) return { type: 'raise', to: Math.min(L.maxTo, L.minTo + Math.floor(Math.random() * 2) * view.hand.bb) };
  if (L.minTo != null && x > 0.985) return { type: 'allin' };
  return L.canCheck ? { type: 'check' } : { type: 'call' };
}
// 呼ばれるたびに時間で進むものを進める：Bot の入室・Bot の手番・時間切れ・次のハンド
function advance(R) {
  const now = Date.now();
  let room = R.room;
  if (!room.started && room.status === 'waiting' && room.members.includes(ME) && now >= R.nextJoin) {
    const uid = botUid(); R.bots.add(uid);
    save(R, { room: joinRoom(room, uid, pickName(room.names), now, Math.random) });
    R.nextJoin = now + WAIT;
    return advance(R);
  }
  room = R.room;
  if (!room.started || !['running', 'paused'].includes(room.status)) return;
  for (let guard = 0; guard < 20; guard++) {
    const st = R.room.state, h = st.hand;
    if (st.status === 'running' && h && h.phase === 'betting' && R.bots.has(R.room.members[h.toAct]) && !IDLE && st.players[h.toAct].status === 'active') {
      if (!R.botAt) R.botAt = now + THINK[0] + Math.random() * (THINK[1] - THINK[0]);
      if (now < R.botAt) return;
      R.botAt = 0;
      const seat = h.toAct, view = viewsOf(R.room)[seat], mv = botMove(view, seat);
      try { save(R, applyRequest(R.room, R.room.members[seat], { op: 'act', ver: R.room.ver, move: mv }, now)); }
      catch (e) { save(R, applyRequest(R.room, R.room.members[seat], { op: 'act', ver: R.room.ver, move: { type: legalActions(view, seat).canCheck ? 'check' : 'fold' } }, now)); }
      continue;
    }
    const at = dueAt(st);
    if (at == null || now < at + (h && h.phase === 'betting' ? 1500 : 0)) return;
    try { save(R, tickRoom(R.room, R.room.members.find(u => R.bots.has(u)) ?? ME, now)); } catch (e) { return; }
  }
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
      return lag({ ver: r.ver, now: r.now, view: r.ver > (args.p_ver ?? -1) ? { ...r.view, status: R.room.status } : null });
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
        const cur = mine(); if (cur) throw new MoveError('in_other_room', { room: cur.room.id });
        const id = crypto.randomUUID();
        const room = createRoom({ id, code: genCode(Math.random), kind: body.kind, uid: ME, name: me.nickname, config: body.config, now });
        const R = { room, hands: [], bots: new Set(), botAt: 0, nextJoin: now + WAIT * 2 };
        rooms.set(id, R);
        return lag(replyOf(R));
      }
      case 'join': {
        const R = [...rooms.values()].find(x => x.room.code === body.code && ['waiting', 'running', 'paused'].includes(x.room.status));
        if (!R) throw new MoveError('not_found');
        if (!R.room.members.includes(ME)) {
          const cur = mine(); if (cur) throw new MoveError('in_other_room', { room: cur.room.id });
          save(R, { room: joinRoom(R.room, ME, me.nickname, now, Math.random) });
          R.nextJoin = now + WAIT;
        }
        return lag(replyOf(R));
      }
      case 'leave': { const R = rooms.get(body.room); if (!R) throw new MoveError('not_found'); save(R, leaveRoom(R.room, ME, now)); return lag(replyOf(R)); }
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
      default: throw new MoveError('malformed');
    }
  } catch (e) {
    if (e instanceof MoveError) { const x = fail(e.code); x.data = { error: e.code, ...(e.extra || {}) }; throw x; }
    throw e;
  }
}
// 開発中の確認用
window.__fake = { rooms, roomInfo, handRecord };
