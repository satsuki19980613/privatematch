// 成績とハンド履歴の保存先：この端末の IndexedDB（サーバーには残さない。サーバーの記録は終局から 3 日で消える）。
//   games: 1 試合 1 件（keyPath roomId）
//     { roomId, code, kind, config, seat, names, players: [{ name, place, pt }], place, pt, status, startedAt, endedAt, hands, savedAt }
//   hands: 1 ハンド 1 件（keyPath [roomId, handNo]）。記録（engine.handRecord の rec）に自分の手札 hole を足したもの
const DB_NAME = 'privatematch', VER = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((ok, fail) => {
    if (!globalThis.indexedDB) return fail(new Error('no indexedDB'));
    const rq = indexedDB.open(DB_NAME, VER);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains('games')) db.createObjectStore('games', { keyPath: 'roomId' });
      if (!db.objectStoreNames.contains('hands')) db.createObjectStore('hands', { keyPath: ['roomId', 'handNo'] }).createIndex('room', 'roomId');
    };
    rq.onsuccess = () => ok(rq.result);
    rq.onerror = () => fail(rq.error);
  });
  dbp.catch(() => { dbp = null; });
  return dbp;
}
const done = t => new Promise((ok, fail) => { t.oncomplete = () => ok(); t.onerror = () => fail(t.error); t.onabort = () => fail(t.error); });
const req = r => new Promise((ok, fail) => { r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); });

export async function putGame(g) {
  const db = await open(), t = db.transaction('games', 'readwrite');
  t.objectStore('games').put({ ...g, savedAt: Date.now() });
  await done(t);
}
export async function getGame(roomId) {
  const db = await open();
  return (await req(db.transaction('games').objectStore('games').get(roomId))) ?? null;
}
export async function allGames() {
  const db = await open();
  return req(db.transaction('games').objectStore('games').getAll());
}
export async function putHands(roomId, list) {
  if (!list.length) return;
  const db = await open(), t = db.transaction('hands', 'readwrite'), s = t.objectStore('hands');
  for (const h of list) s.put({ ...h, roomId });
  await done(t);
}
export async function handsOf(roomId) {
  const db = await open();
  const list = await req(db.transaction('hands').objectStore('hands').index('room').getAll(roomId));
  return list.sort((a, b) => a.handNo - b.handNo);
}
/** その試合で保存済みの最後のハンド番号（無ければ 0） */
export async function lastHandNo(roomId) {
  const db = await open();
  const keys = await req(db.transaction('hands').objectStore('hands').index('room').getAllKeys(roomId));
  return keys.reduce((m, k) => Math.max(m, k[1]), 0);
}

/** 書き出し（バックアップ用の JSON） */
export async function exportAll() {
  const db = await open();
  const games = await req(db.transaction('games').objectStore('games').getAll());
  const hands = await req(db.transaction('hands').objectStore('hands').getAll());
  return { app: 'privatematch', version: 1, exportedAt: Date.now(), games, hands };
}
/** 読み込む行の検証（書き出したものと同じ形だけを受け付ける。壊れた行や細工した行で画面が壊れないように） */
const num = v => typeof v === 'number' && Number.isFinite(v);
const int = v => Number.isInteger(v);
const optInt = v => v == null || int(v);
const optNum = v => v == null || num(v);
const str = (v, max = 200) => typeof v === 'string' && v.length <= max;
const card = c => int(c) && c >= 0 && c < 52;
const cards = v => v == null || (Array.isArray(v) && v.length <= 5 && v.every(card));
const nums = (v, n = 6) => Array.isArray(v) && v.length <= n && v.every(x => x == null || num(x));
const KINDS = ['fold', 'check', 'call', 'bet', 'raise', 'allin'];
export function validGame(g) {
  return !!g && typeof g === 'object' && str(g.roomId, 64) && optInt(g.seat) && g.seat >= 0 && g.seat < 6 &&
    ['running', 'finished', 'cancelled'].includes(g.status) && ['private', 'free'].includes(g.kind) && (g.code == null || str(g.code, 16)) &&
    !!g.config && typeof g.config === 'object' && int(g.config.players) && g.config.players >= 2 && g.config.players <= 6 &&
    Array.isArray(g.names) && g.names.length <= 6 && g.names.every(x => str(x, 64)) &&
    Array.isArray(g.players) && g.players.length <= 6 && g.players.every(p => p && typeof p === 'object' && str(p.name ?? '', 64) && optInt(p.place) && optNum(p.pt)) &&
    optInt(g.place) && (g.place == null || (g.place >= 1 && g.place <= 6)) && optNum(g.pt) && optNum(g.startedAt) && optNum(g.endedAt) && optInt(g.hands);
}
export function validHand(h) {
  return !!h && typeof h === 'object' && str(h.roomId, 64) && int(h.handNo) && h.handNo > 0 && int(h.level) && num(h.bb) && num(h.sb) && num(h.ante) &&
    optInt(h.btn) && optInt(h.sbSeat) && int(h.bbSeat) && nums(h.startStacks) && cards(h.board) && cards(h.hole) &&
    Array.isArray(h.shown) && h.shown.length <= 6 && h.shown.every(x => x == null || x === false || (Array.isArray(x) && x.every(card))) &&
    Array.isArray(h.names) && h.names.every(x => x == null || str(x, 64)) &&
    Array.isArray(h.actions) && h.actions.every(a => a && int(a.seat) && int(a.street) && KINDS.includes(a.kind) && optNum(a.betTo) && optNum(a.put)) &&
    Array.isArray(h.pots) && h.pots.every(p => p && num(p.amount) && Array.isArray(p.winners) && p.winners.every(int)) &&
    Array.isArray(h.eliminated) && h.eliminated.every(e => e && int(e.seat) && int(e.place)) && Array.isArray(h.won);
}
/** 端末の行のほうが進んでいれば、読み込む行で上書きしない（古い書き出しで「途中」に戻さない） */
const newer = (cur, g) => cur && (cur.status !== 'running' && g.status === 'running' || (cur.status === g.status && (cur.hands ?? 0) > (g.hands ?? 0)));

/** 読み込み（同じ試合・ハンドは上書き。ただし端末のほうが進んだ試合はそのまま）。=> 保存した試合数 */
export async function importAll(data) {
  if (!data || data.app !== 'privatematch' || !Array.isArray(data.games) || !Array.isArray(data.hands)) throw new Error('format');
  const games = data.games.filter(validGame), hands = data.hands.filter(validHand);
  const db = await open(), t = db.transaction(['games', 'hands'], 'readwrite'), gs = t.objectStore('games'), hs = t.objectStore('hands');
  let n = 0;
  for (const g of games) {
    const rq = gs.get(g.roomId);
    rq.onsuccess = () => { if (!newer(rq.result, g)) { gs.put(g); n++; } };
  }
  for (const h of hands) hs.put(h);
  await done(t);
  return n;
}
