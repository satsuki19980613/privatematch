// 部屋のルール（docs/ARCHITECTURE.md §4）：作成・参加（満席で開始）・退出・アクション・時間で進む処理・ビュー・チャット。
// 入出力も時計も持たない純関数（now と rnd は引数で受け取る）。fakeNet もブラウザでこれを使う。
//
// 部屋 room = { id, code, kind, host, config, status, started, members: [uid], names: [表示名], state, ver, createdAt, startedAt, rematch }
//   status: 'waiting' | 'running' | 'paused' | 'finished' | 'cancelled'（開始後はエンジンの状態と同じ）
//   members: 待機中は参加順（先頭が作成者）、開始後は席順。state はエンジンの状態（山札を含む。サーバーだけが持つ）
//   rematch: 終局後の再戦の受付 { stay: [席]（席に残った順）, gone: [席]（Menu へ去った）, next: { id, code } | null（始まった再戦の部屋） }。無ければ null
import { newTable, act, tick, sitin, sitout, leave, viewFor, handRecord, dueAt, EngineError } from '../../src/engine.js';
import { normalizeConfig, WAITING_EXPIRES_MS, REMATCH_MS, REMATCH_HOST_WAIT_MS } from '../../src/structure.js';
import { normalizeChat, CHAT_MIN_INTERVAL_MS } from '../../src/chat.js';

export const KINDS = ['private', 'free'];

export class MoveError extends Error {
  constructor(code, extra) { super(code); this.code = code; this.extra = extra; }
}

const clone = x => structuredClone(x);
export function shuffle(a, rnd) { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
/** 部屋番号（6 桁） */
export const genCode = rnd => String(Math.floor(rnd() * 1e6)).padStart(6, '0');

const live = room => ['waiting', 'running', 'paused'].includes(room.status);

/** 部屋を作る（作成者が最初の参加者） */
export function createRoom({ id, code, kind, uid, name, config, now }) {
  if (!KINDS.includes(kind)) throw new MoveError('malformed');
  const cfg = normalizeConfig(config);
  if (!cfg) throw new MoveError('malformed');
  return { id, code, kind, host: uid, config: cfg, status: 'waiting', started: false, members: [uid], names: [name], state: null, ver: 1, createdAt: now, startedAt: null, rematch: null };
}

/** 参加する。満席になったら席をシャッフルして開始する。=> 新しい room（引数は変えない） */
export function joinRoom(room, uid, name, now, rnd) {
  if (room.members.includes(uid)) return room;
  if (room.status !== 'waiting' || room.started) throw new MoveError('room_closed');
  if (now - room.createdAt >= WAITING_EXPIRES_MS) throw new MoveError('room_closed');
  if (room.members.length >= room.config.players) throw new MoveError('room_full');
  const r = clone(room);
  r.members.push(uid); r.names.push(name); r.ver++;
  if (r.members.length === r.config.players) start(r, now, rnd);
  return r;
}
function start(r, now, rnd) {
  const order = shuffle(r.members.map((u, i) => i), rnd);
  r.members = order.map(i => r.members[i]); r.names = order.map(i => r.names[i]);
  r.state = newTable({ config: r.config, names: r.names, now, rnd });
  r.started = true; r.startedAt = now; r.status = r.state.status;
}

const seatOf = (room, uid) => room.members.indexOf(uid);
function engineCall(fn) {
  try { return fn(); } catch (e) {
    if (e instanceof MoveError) throw e;
    if (e instanceof EngineError) throw new MoveError(['not_your_turn', 'game_over', 'not_yet'].includes(e.code) ? e.code : 'illegal');
    throw e;
  }
}
// エンジンを 1 手進めた結果を部屋に戻す。ハンドが終わっていれば記録を返す
function stepped(room, st) {
  const r = { ...room, state: st, status: st.status, ver: room.ver + 1 };
  const before = room.state && room.state.hand, after = st.hand;
  const done = after && after.phase === 'settled' && !(before && before.handNo === after.handNo && before.phase === 'settled');
  return { room: r, record: done ? handRecord(st) : null };
}

/** 退出。待機中は席を離れる（作成者なら部屋ごと中止）。進行中は left（戻れない）。=> { room, record } */
export function leaveRoom(room, uid, now) {
  const seat = seatOf(room, uid);
  if (seat < 0) throw new MoveError('not_found');
  // 終局後・飛んだ後に Menu へ戻る：再戦の対象から外す（作成者なら再戦を始める役が残った人へ移る）
  if (room.started && (room.status === 'finished' || (live(room) && room.state.players[seat].status === 'out'))) return { room: markGone(room, seat), record: null };
  if (!live(room)) throw new MoveError('game_over');
  if (!room.started) {
    const r = clone(room);
    if (uid === room.host) { r.status = 'cancelled'; r.ver++; return { room: r, record: null }; }
    r.members.splice(seat, 1); r.names.splice(seat, 1); r.ver++;
    return { room: r, record: null };
  }
  const st = clone(room.state);
  engineCall(() => leave(st, seat, now));
  return stepped(room, st);
}

/** 席に着いている人の操作。req = { op: 'act', ver, move } | { op: 'sitout' } | { op: 'sitin' }。=> { room, record } */
export function applyRequest(room, uid, req, now) {
  const seat = seatOf(room, uid);
  if (seat < 0) throw new MoveError('not_found');
  if (!room.started) throw new MoveError('not_started');
  if (!live(room)) throw new MoveError('game_over');
  const st = clone(room.state);
  if (req.op === 'act') {
    if (req.ver !== room.ver) throw new MoveError('stale');
    const m = req.move;
    if (!m || typeof m !== 'object' || !['fold', 'check', 'call', 'raise', 'allin'].includes(m.type)) throw new MoveError('illegal');
    if (m.type === 'raise' && !Number.isInteger(m.to)) throw new MoveError('illegal');
    engineCall(() => act(st, seat, m.type === 'raise' ? { type: 'raise', to: m.to } : { type: m.type }, now));
  } else if (req.op === 'sitout') engineCall(() => sitout(st, seat, now));
  else if (req.op === 'sitin') engineCall(() => sitin(st, seat, now));
  else throw new MoveError('malformed');
  return stepped(room, st);
}

/** 期限を過ぎたものを 1 つ進める（席の誰が呼んでもよい）。何も無ければ MoveError('not_yet')。=> { room, record } */
export function tickRoom(room, uid, now) {
  if (seatOf(room, uid) < 0) throw new MoveError('not_found');
  if (!room.started) throw new MoveError('not_yet');
  if (!live(room)) throw new MoveError('game_over');
  const st = clone(room.state);
  engineCall(() => tick(st, now));
  return stepped(room, st);
}

/**
 * チャットの発言（PRIVATE MATCH の卓だけ。開始後なら終局後も部屋がある限り送れる）。ゲームの ver とは独立（room は変えない）。
 * lastAt はその席の最後の発言時刻（ms。無ければ null）。=> { seat, text }（text は normalizeChat 済み）
 */
export function postChat(room, uid, text, lastAt, now) {
  const seat = seatOf(room, uid);
  if (seat < 0) throw new MoveError('not_found');
  if (room.kind !== 'private' || !room.started) throw new MoveError('chat_closed');
  const t = normalizeChat(text);
  if (t == null) throw new MoveError('malformed');
  if (lastAt != null && now - lastAt < CHAT_MIN_INTERVAL_MS) throw new MoveError('too_fast');
  return { seat, text: t };
}

/* ---------------- 再戦（終局後に席に残った人で、同じ設定の新しい部屋を始める） ---------------- */
const rematchOf = room => room.rematch ?? { stay: [], gone: [], next: null };
// ビューと判定に使う形：途中で退出した（left）席も去った扱い。host は作成者の席
function rematchView(room) {
  const rm = rematchOf(room), left = room.state.players.map((p, s) => (p.status === 'left' ? s : -1)).filter(s => s >= 0);
  return { ...rm, gone: [...new Set([...rm.gone, ...left])], host: room.members.indexOf(room.host), closesAt: room.state.endedAt + REMATCH_MS };
}
/** 再戦を受け付けているか（終局から REMATCH_MS の間・まだ始まっていない） */
export const rematchOpen = (room, now) => room.started && room.status === 'finished' && !rematchOf(room).next && now - room.state.endedAt < REMATCH_MS;
/**
 * 再戦を始められる席（ビューの rematch でも同じ関数を使う）。rm = { stay, gone, host（作成者の席）}、endedAt = 終局の時刻。
 * 作成者が残っているか、まだ去っておらず終局から REMATCH_HOST_WAIT_MS 以内なら作成者。そうでなければ先に席に残った人（いなければ null）
 */
export function rematchLeader(rm, endedAt, now) {
  if (rm.stay.includes(rm.host) || (!rm.gone.includes(rm.host) && now - endedAt < REMATCH_HOST_WAIT_MS)) return rm.host;
  return rm.stay[0] ?? null;
}
function markGone(room, seat) {
  const rm = rematchOf(room);
  if (rm.gone.includes(seat) && !rm.stay.includes(seat)) return room;
  const r = clone(room);
  r.rematch = { ...rm, stay: rm.stay.filter(s => s !== seat), gone: [...rm.gone, seat] }; r.ver++;
  return r;
}
/** 終局後に席に残る（再戦を待つ）。=> { room, record: null } */
export function stayRoom(room, uid, now) {
  const seat = seatOf(room, uid);
  if (seat < 0) throw new MoveError('not_found');
  if (!rematchOpen(room, now) || room.state.players[seat].status === 'left') throw new MoveError('room_closed');
  const rm = rematchOf(room);
  if (rm.stay.includes(seat)) return { room, record: null };
  const r = clone(room);
  r.rematch = { ...rm, stay: [...rm.stay, seat], gone: rm.gone.filter(s => s !== seat) }; r.ver++;
  return { room: r, record: null };
}
/**
 * 再戦を始める（再戦を始められる席の人だけ）。押した人も席に残ったことになる。席に残った人のうち、ほかの部屋に居る人（busy: Set<uid>）は除く。
 * names: uid → 今の表示名。=> { room: 元の部屋（rematch.next に新しい部屋）, next: 開始済みの新しい部屋（人数 = 残った人数、ほかの設定は同じ）}
 */
export function rematchRoom(room, uid, { id, code, names, busy = new Set() }, now, rnd) {
  const seat = seatOf(room, uid);
  if (seat < 0) throw new MoveError('not_found');
  if (!rematchOpen(room, now)) throw new MoveError('room_closed');
  const rm = rematchOf(room);
  if (rematchLeader(rematchView(room), room.state.endedAt, now) !== seat) throw new MoveError('not_host');
  const stay = rm.stay.includes(seat) ? rm.stay : [...rm.stay, seat];
  const uids = stay.map(s => room.members[s]).filter(u => u === uid || !busy.has(u));
  if (uids.length < 2) throw new MoveError('not_enough');
  const next = createRoom({ id, code, kind: room.kind, uid, name: names.get(uid) ?? room.names[seat], config: { ...room.config, players: uids.length }, now });
  next.members = uids; next.names = uids.map(u => names.get(u) ?? room.names[seatOf(room, u)]);
  start(next, now, rnd);
  const r = clone(room);
  r.rematch = { ...rm, stay, next: { id, code } }; r.ver++;
  return { room: r, next };
}

/** 次に何かが起きる時刻（DB の due_ms） */
export const dueOf = room => (room.started && live(room) ? dueAt(room.state) : null);

/** 部屋の公開情報（ビューの room 欄と待機室） */
export function roomInfo(room) {
  return { id: room.id, code: room.code, kind: room.kind, config: room.config, hostName: room.names[room.members.indexOf(room.host)] ?? null, createdAt: room.createdAt, startedAt: room.startedAt };
}

/** 保存するビュー。開始前は待機室 1 つ、開始後は席ごと（自分の手札だけが見える） */
export function viewsOf(room) {
  const info = roomInfo(room);
  if (!room.started) {
    return [{ lobby: true, ver: room.ver, status: room.status, room: info, members: room.names.slice(), expiresAt: room.createdAt + WAITING_EXPIRES_MS }];
  }
  const rm = room.status === 'finished' ? rematchView(room) : null;
  return room.members.map((_, seat) => ({ ...viewFor(room.state, seat), ver: room.ver, room: info, rematch: rm }));
}
