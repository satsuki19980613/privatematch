// Neon Function "game"：HTTP の振る舞い（CORS・認証・振り分け）。JWT の検証と DB は deps で受け取り、単体テストできるようにする。
import { MoveError, KINDS } from './rules.js';
import { normalizeFx } from '../../src/fx.js';

export const MAX_BODY = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[0-9]{6}$/;
// MoveError の code → HTTP ステータス（それ以外は 422）
export const STATUS = {
  not_found: 404, no_profile: 403, stale: 409, not_yet: 409, game_over: 409, not_your_turn: 409, busy: 409, not_started: 409,
  room_closed: 409, room_full: 409, in_other_room: 409, illegal: 422, malformed: 422,
  chat_closed: 409, too_fast: 429, chat_full: 409, not_host: 409, not_enough: 409, too_many: 429,
};

export function createHandler(deps) {
  const allowed = new Set(deps.allowedOrigins);
  const log = deps.logError ?? ((m, e) => console.error(m, e));
  // 1 人あたりの連打の制限：deps.flood(uid) が false なら 429。数えるのは DB（db.js の flood。Function はリクエストごとにメモリが分かれるため）。
  // 数えるのに失敗したときは止めない（その先の処理が同じ DB を使うので、落ちていればそこで分かる）
  async function allow(uid) {
    if (!deps.flood) return true;
    try { return await deps.flood(uid); } catch (e) { log('game: flood', e); return true; }
  }
  return async req => {
    const origin = req.headers.get('Origin');
    const cors = { Vary: 'Origin' }; if (origin && allowed.has(origin)) cors['Access-Control-Allow-Origin'] = origin;
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' } });
    if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('Authorization') ?? '');
    let uid = null; if (m) try { uid = await deps.verifyToken(m[1]); } catch (e) { if (e && e.unavailable) return reply(503, { error: 'unavailable' }); uid = null; }
    if (!uid) return reply(401, { error: 'not_authenticated' });
    if (!(await allow(uid))) return reply(429, { error: 'too_many' });
    let body;
    try {
      // 上限はバイト数で（先に Content-Length を見て、大きければ読まない）
      if (Number(req.headers.get('Content-Length')) > MAX_BODY) return reply(422, { error: 'malformed' });
      const buf = new Uint8Array(await req.arrayBuffer()); if (buf.length > MAX_BODY) return reply(422, { error: 'malformed' });
      body = JSON.parse(new TextDecoder().decode(buf));
    } catch { return reply(422, { error: 'malformed' }); }
    if (!body || typeof body !== 'object') return reply(422, { error: 'malformed' });
    const room = typeof body.room === 'string' && UUID.test(body.room) ? body.room : null;
    // 演出 GIF（create / join / stay / rematch に任意で付く。正しくない slug は「なし」として扱い、参加は止めない）
    const fx = body.fx === undefined ? undefined : normalizeFx(body.fx);
    try {
      switch (body.op) {
        case 'create':
          if (!KINDS.includes(body.kind) || !body.config || typeof body.config !== 'object') return reply(422, { error: 'malformed' });
          return reply(200, await deps.create(uid, body.kind, body.config, fx));
        case 'join':
          if (typeof body.code !== 'string' || !CODE.test(body.code)) return reply(422, { error: 'malformed' });
          return reply(200, await deps.join(uid, body.code, fx));
        case 'leave':
          if (!room) return reply(422, { error: 'malformed' });
          return reply(200, await deps.leave(uid, room));
        case 'act':
          if (!room || !Number.isInteger(body.ver) || !body.move || typeof body.move !== 'object') return reply(422, { error: 'malformed' });
          return reply(200, await deps.request(uid, room, { op: 'act', ver: body.ver, move: body.move }));
        case 'stay':
          if (!room) return reply(422, { error: 'malformed' });
          return reply(200, await deps.stay(uid, room, fx));
        case 'rematch':
          if (!room) return reply(422, { error: 'malformed' });
          return reply(200, await deps.rematch(uid, room, fx));
        case 'sitout': case 'sitin':
          if (!room) return reply(422, { error: 'malformed' });
          return reply(200, await deps.request(uid, room, { op: body.op }));
        case 'tick':
          if (!room) return reply(422, { error: 'malformed' });
          return reply(200, await deps.tick(uid, room));
        case 'fx':
          if (!room) return reply(422, { error: 'malformed' });
          return reply(200, await deps.setFx(uid, room, fx ?? null));
        case 'chat':
          if (!room || typeof body.text !== 'string') return reply(422, { error: 'malformed' });
          return reply(200, await deps.chat(uid, room, body.text));
        default:
          return reply(422, { error: 'malformed' });
      }
    } catch (e) {
      if (e instanceof MoveError) return reply(STATUS[e.code] ?? 422, { error: e.code, ...(e.extra || {}) });
      log('game: unexpected error', e);
      return reply(500, { error: 'internal' });
    }
  };
}
