// サーバー（room_hands / room_poll）から端末の IndexedDB へ、終わったハンドと試合の結果を写す。
// 卓ではハンドが終わるたびに、起動時には me().recent（3 日以内に打った部屋）について呼ぶ。同じ部屋の同期は直列にする。
import { app } from '../ui/util.js';
import * as store from './store.js';

const chains = new Map();

/** 部屋のビューから試合の記録（store の games の形）を作る */
export function gameSummary(view, roomId, hands) {
  const me = view.seat, p = view.players[me];
  return {
    roomId, code: view.room.code, kind: view.room.kind, config: view.config, seat: me, names: view.names.slice(),
    players: view.players.map((x, s) => ({ name: view.names[s], place: x.place, pt: x.pt })),
    place: p.place, pt: p.pt, status: view.status, startedAt: view.startedAt, endedAt: view.endedAt, hands,
  };
}

async function run(roomId, view) {
  if (!view) view = (await app.net.rpc('room_poll', { p_room: roomId, p_ver: -1 })).view;
  if (!view || view.lobby) return;
  let after = await store.lastHandNo(roomId);
  for (let i = 0; i < 50; i++) {
    const list = await app.net.rpc('room_hands', { p_room: roomId, p_after: after });
    if (!Array.isArray(list) || !list.length) break;
    await store.putHands(roomId, list);
    after = list.at(-1).handNo;
    if (list.length < 200) break;
  }
  await store.putGame(gameSummary(view, roomId, after));
}

/** 1 部屋を同期する（失敗しても投げない。=> 成功したか） */
export function syncRoom(roomId, view = null) {
  const prev = chains.get(roomId) || Promise.resolve();
  const p = prev.then(() => run(roomId, view)).then(() => true, () => false);
  chains.set(roomId, p);
  p.finally(() => { if (chains.get(roomId) === p) chains.delete(roomId); });
  return p;
}

/** 起動時：最近の部屋のうち、端末にまだ最後まで写っていないものを同期する */
export async function syncRecent(recent) {
  for (const r of recent || []) {
    try {
      const g = await store.getGame(r.id);
      if (g && (g.status === 'finished' || g.status === 'cancelled')) continue;
      await syncRoom(r.id);
    } catch (e) { /* IndexedDB が使えない環境など */ }
  }
}
