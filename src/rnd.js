// 部屋番号・席順・山札のシャッフルに使う乱数（Math.random は使わない）。サーバー（server/game/db.js）とデモ用のサーバー（src/fakeNet.js）で同じもの。
// => 0 以上 1 未満（53 bit）
export const secureRnd = () => { const a = crypto.getRandomValues(new Uint32Array(2)); return ((a[0] >>> 5) * 67108864 + (a[1] >>> 6)) / 9007199254740992; };
