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
/** 読み込み（同じ試合・ハンドは上書き）。=> 読み込んだ試合数 */
export async function importAll(data) {
  if (!data || data.app !== 'privatematch' || !Array.isArray(data.games) || !Array.isArray(data.hands)) throw new Error('format');
  const db = await open(), t = db.transaction(['games', 'hands'], 'readwrite');
  for (const g of data.games) if (g && typeof g.roomId === 'string') t.objectStore('games').put(g);
  for (const h of data.hands) if (h && typeof h.roomId === 'string' && Number.isInteger(h.handNo)) t.objectStore('hands').put(h);
  await done(t);
  return data.games.length;
}
