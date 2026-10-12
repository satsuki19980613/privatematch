// 部屋番号・席順・山札のシャッフルに使う乱数（Math.random は使わない）。サーバー（server/game/db.js）とデモ用のサーバー（src/fakeNet.js）で同じもの。
// => 0 以上 1 未満（53 bit）
export const secureRnd = () => { const a = crypto.getRandomValues(new Uint32Array(2)); return ((a[0] >>> 5) * 67108864 + (a[1] >>> 6)) / 9007199254740992; };

/** 種から決まる乱数（デモのサンプル用。同じ種なら同じ並びになる。本物の配りには使わない）=> 0 以上 1 未満 */
export function seeded(seed) {
  return () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
