// 部屋のルール（docs/ARCHITECTURE.md §4）：作成・参加（満席で開始）・退出・アクション・時間で進む処理・ビュー・チャット。
// 入出力も時計も持たない純関数（now と rnd は引数で受け取る）。fakeNet もブラウザでこれを使う。
//
// 部屋 room = { id, code, kind, host, config, status, started, members: [uid], names: [表示名], state, ver, createdAt, startedAt }
//   status: 'waiting' | 'running' | 'paused' | 'finished' | 'cancelled'（開始後はエンジンの状態と同じ）
//   members: 待機中は参加順（先頭が作成者）、開始後は席順。state はエンジンの状態（山札を含む。サーバーだけが持つ）
import { newTable, act, tick, sitin, sitout, leave, viewFor, handRecord, dueAt, EngineError } from '../../src/engine.js';
import { normalizeConfig, WAITING_EXPIRES_MS } from '../../src/structure.js';
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
  return { id, code, kind, host: uid, config: cfg, status: 'waiting', started: false, members: [uid], names: [name], state: null, ver: 1, createdAt: now, startedAt: null };
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
  return room.members.map((_, seat) => ({ ...viewFor(room.state, seat), ver: room.ver, room: info }));
}
