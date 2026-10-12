// FRIEND MATCH：集計（src/friend.js）・見本（src/friendDemo.js）・部屋の決まり（rules.js）・Discord の確認（discord.js）・HTTP（handler.js）の単体テストと、
// TEST_DATABASE_URL があるときだけ動く DB の結合テスト（専用のデータベースを作る。test/dbkit.js）。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import {
  ALL, MAX_FOCUS, COLUMNS, TREND_METRICS, seasonLabel, seasonShort, dayOf, dayShort, metricsOf, memberRows, totalOf, ranking, sortRows,
  cumulative, cumulativeSeasons, trend, toggleFocus, slotOf, parseFocus, fmtRate, fmtNum,
} from '../src/friend.js';
import { aggregate, sampleRows, seasonAt, demoKey } from '../src/friendDemo.js';
import { createRoom, joinRoom, leaveRoom, applyRequest, tickRoom, postChat, setRoomFx, friendResults, social, KINDS } from '../server/game/rules.js';
import { makeDiscord, STATE_TTL_MS } from '../server/game/discord.js';
import { createHandler, STATUS } from '../server/game/handler.js';
import { makeDb } from '../server/game/db.js';
import { DEFAULT_CONFIG, MODE_IDS, payoutsFor } from '../src/structure.js';
import { legalActions } from '../src/engine.js';
import { survivalTurns } from '../src/history/stats.js';
import { seeded } from '../src/rnd.js';
import { DBURL, openTestDb, playOut } from './dbkit.js';

const U = i => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const JST = (y, m, d, h = 12) => Date.UTC(y, m - 1, d, h - 9);
const row = (k, mode, at, place, pt, hands = 20, vpip = 5, pfr = 3) => ({ k, name: k.toUpperCase(), mode, at, place, pt, hands, vpip, pfr });
// 3 人・2 シーズンの小さな見本（club）。a は両方のシーズン、c は 10 月だけ
const ROWS = [
  row('a', 'club', JST(2026, 9, 3), 1, 5), row('b', 'club', JST(2026, 9, 3), 2, 3),
  row('a', 'club', JST(2026, 10, 1), 2, 3), row('b', 'club', JST(2026, 10, 1), 1, 5), row('c', 'club', JST(2026, 10, 1), 3, 2),
  row('a', 'club', JST(2026, 10, 2), 1, 5), row('c', 'club', JST(2026, 10, 2), 2, 3),
  row('a', 'rank-3', JST(2026, 10, 2), 3, 5), row('b', 'rank-3', JST(2026, 10, 2), 6, -15),
];
const DATA = aggregate(ROWS, { me: 'a', mode: 'club' });

describe('FRIEND MATCH の集計', () => {
  test('シーズンと日付は日本時間', () => {
    assert.equal(dayOf(Date.UTC(2026, 8, 30, 14, 59)), '2026-09-30');
    assert.equal(dayOf(Date.UTC(2026, 8, 30, 15, 0)), '2026-10-01');   // 日本時間の 0 時
    assert.equal(seasonAt(Date.UTC(2026, 8, 30, 15, 0)), '2026-10');
    assert.equal(seasonLabel('2026-10'), '2026年10月'); assert.equal(seasonLabel('2026-01'), '2026年1月'); assert.equal(seasonLabel(ALL), '通算');
    assert.equal(seasonShort('2026-09'), '26/9'); assert.equal(dayShort('2026-10-02'), '10/2');
  });

  test('見本の aggregate：モードで分け、シーズンを選ぶ（知らない値は最新）', () => {
    assert.deepEqual(DATA.seasons, ['2026-09', '2026-10']); assert.equal(DATA.season, '2026-10'); assert.equal(DATA.me, 'a');
    assert.deepEqual(DATA.members.map(m => m.k), ['a', 'b', 'c']);
    assert.equal(DATA.games.length, 5); assert.ok(DATA.games.every(g => seasonAt(g.at) === '2026-10'));
    assert.equal(aggregate(ROWS, { me: 'a', mode: 'club', season: '2026-09' }).games.length, 2);
    assert.equal(aggregate(ROWS, { me: 'a', mode: 'club', season: '1999-01' }).season, '2026-10');
    const rank = aggregate(ROWS, { me: 'a', mode: 'rank-3' });
    assert.deepEqual(rank.members.map(m => m.k), ['a', 'b']); assert.deepEqual(rank.seasons, ['2026-10']);
    const none = aggregate(ROWS, { me: 'a', mode: 'legend-avg' });
    assert.deepEqual([none.season, none.seasons, none.members, none.agg, none.games], [null, [], [], [], []]);
  });

  test('メンバーごとの指標（平均 pt・加点率・1 位率・平均順位・生存ターン）。モードもシーズンも混ぜない', () => {
    const oct = memberRows(DATA, '2026-10'), a = oct.find(r => r.k === 'a');
    assert.deepEqual([a.n, a.pt, a.avg, a.plusRate, a.firstRate, a.avgPlace, a.me], [2, 8, 4, 1, 0.5, 1.5, true]);
    assert.deepEqual(a.dist, [1, 1, 0, 0, 0, 0]);
    assert.equal(a.survival, survivalTurns(40, { n: 10, d: 40 }, 2)); assert.equal(a.survival, 80);   // 40 ハンド ÷ 25% × 100 ÷ 2 試合
    assert.deepEqual([a.vpipRate, a.pfrRate], [0.25, 0.15]);
    assert.deepEqual(oct.map(r => r.k), ['a', 'b', 'c']);
    assert.deepEqual(memberRows(DATA, '2026-09').map(r => [r.k, r.pt]), [['a', 5], ['b', 3]]);   // c は 9 月に打っていない
    const all = memberRows(DATA, ALL);
    assert.deepEqual(all.map(r => [r.k, r.n, r.pt]), [['a', 3, 13], ['b', 2, 8], ['c', 2, 5]]);
    assert.deepEqual(memberRows(DATA).map(r => r.pt), all.map(r => r.pt));
    // 参加 0 は率を出さない
    const zero = metricsOf({ n: 0, pt: 0, plus: 0, first: 0, place: 0, hands: 0, vpip: 0, pfr: 0, dist: [0, 0, 0, 0, 0, 0] });
    assert.deepEqual([zero.avg, zero.plusRate, zero.firstRate, zero.avgPlace, zero.vpipRate, zero.survival], [null, null, null, null, null, null]);
    assert.deepEqual(memberRows({ me: 'x' }), []);
  });

  test('全員の合計とメンバー平均の元', () => {
    const t = totalOf(memberRows(DATA, '2026-10'));
    assert.deepEqual([t.players, t.n, t.pt, t.first, t.plus], [3, 5, 18, 2, 5]);
    assert.equal(t.avg, 18 / 5); assert.equal(t.avgPlace, 9 / 5); assert.equal(t.survival, 80);
    const none = totalOf([]);
    assert.deepEqual([none.players, none.n, none.avg, none.survival], [0, 0, null, null]);
  });

  test('ランキング：合計 pt → 平均順位 → 参加数。すべて同じなら同じ順位', () => {
    const r = ranking(memberRows(DATA, ALL));
    assert.deepEqual(r.map(x => [x.rank, x.k]), [[1, 'a'], [2, 'b'], [3, 'c']]);
    const m = (k, pt, avgPlace, n) => ({ k, name: k, pt, avgPlace, n });
    const tied = ranking([m('z', 10, 2, 4), m('y', 10, 2, 4), m('x', 10, 1.5, 4), m('w', 12, 3, 9), m('v', 10, 2, 6), m('u', -3, 4, 1)]);
    assert.deepEqual(tied.map(x => [x.rank, x.k]), [[1, 'w'], [2, 'x'], [3, 'v'], [4, 'y'], [4, 'z'], [6, 'u']]);
    assert.deepEqual(ranking([]), []);
  });

  test('並べ替え：良い順が既定（平均順位は小さい方が良い）。値の無い人は最後', () => {
    const rows = [{ k: 'a', name: 'い', pt: 1, avgPlace: 3, survival: null }, { k: 'b', name: 'あ', pt: 5, avgPlace: 1, survival: 90 }, { k: 'c', name: 'う', pt: 3, avgPlace: 2, survival: 120 }];
    const keys = (key, desc) => sortRows(rows, key, desc).map(r => r.k).join('');
    assert.equal(keys('pt', true), 'bca'); assert.equal(keys('pt', false), 'acb');
    assert.equal(keys('avgPlace', true), 'bca'); assert.equal(keys('avgPlace', false), 'acb');
    assert.equal(keys('survival', true), 'cba'); assert.equal(keys('survival', false), 'bca');
    assert.equal(keys('name', true), 'bac'); assert.equal(keys('name', false), 'cab');
    assert.equal(rows.map(r => r.k).join(''), 'abc');   // 元の並びは変えない
    assert.ok(COLUMNS.every(c => 'pt avg plusRate firstRate avgPlace n survival'.split(' ').includes(c.key)));
  });

  test('累積 pt：シーズン内は日ごと、通算はシーズンごと。平均は打った人数で割る', () => {
    const c = cumulative(DATA.games);
    assert.deepEqual(c.days, ['2026-10-01', '2026-10-02']);
    assert.deepEqual(c.series.get('a'), [3, 8]); assert.deepEqual(c.series.get('b'), [5, 5]); assert.deepEqual(c.series.get('c'), [2, 5]);
    assert.deepEqual(c.avg, [10 / 3, 6]);
    assert.deepEqual(cumulative([]).days, []);
    const s = cumulativeSeasons(DATA);
    assert.deepEqual(s.seasons, ['2026-09', '2026-10']);
    assert.deepEqual(s.series.get('a'), [5, 13]); assert.deepEqual(s.series.get('c'), [0, 5]);
    assert.deepEqual(s.avg, [8 / 3, 26 / 3]);
  });

  test('シーズン推移：参加の無いシーズンは null、率は %、平均は値のある人だけ', () => {
    const pt = trend(DATA, 'pt');
    assert.deepEqual(pt.seasons, ['2026-09', '2026-10']);
    assert.deepEqual(pt.series.get('a'), [5, 8]); assert.deepEqual(pt.series.get('c'), [null, 5]);
    assert.deepEqual(pt.avg, [4, 6]);
    assert.deepEqual(trend(DATA, 'firstRate').series.get('a'), [100, 50]);
    assert.deepEqual(trend(DATA, 'avgPlace').series.get('b'), [2, 1]);
    assert.deepEqual(trend({ seasons: [], members: [], agg: [] }, 'pt').avg, []);
    assert.deepEqual(TREND_METRICS.map(m => m.key), ['pt', 'avg', 'plusRate', 'firstRate', 'avgPlace', 'survival']);
  });

  test('強調する人：空いている最小の色を取り、外すまで変えない。6 人まで', () => {
    let f = toggleFocus([], 'a'); f = toggleFocus(f, 'b'); f = toggleFocus(f, 'c');
    assert.deepEqual(f, [{ k: 'a', slot: 0 }, { k: 'b', slot: 1 }, { k: 'c', slot: 2 }]);
    f = toggleFocus(f, 'b');
    assert.deepEqual([slotOf(f, 'a'), slotOf(f, 'b'), slotOf(f, 'c')], [0, null, 2]);   // 残った人の色は変わらない
    f = toggleFocus(f, 'd');
    assert.equal(slotOf(f, 'd'), 1);
    for (const k of ['e', 'f', 'g', 'h']) f = toggleFocus(f, k);
    assert.equal(f.length, MAX_FOCUS); assert.equal(slotOf(f, 'h'), null);
    assert.deepEqual(parseFocus(JSON.stringify(f)), f);
    assert.deepEqual(parseFocus('not json'), []); assert.deepEqual(parseFocus('{"k":"a"}'), []);
    assert.deepEqual(parseFocus(JSON.stringify([{ k: 'a', slot: 0 }, { k: 'b', slot: 0 }, { k: 'a', slot: 1 }, { k: 'c', slot: 9 }, { k: 5, slot: 2 }, null, { k: 'd', slot: 3 }])), [{ k: 'a', slot: 0 }, { k: 'd', slot: 3 }]);
  });

  test('表示', () => {
    assert.equal(fmtRate(0.4567), '45.7%'); assert.equal(fmtRate(null), '–'); assert.equal(fmtRate(1), '100.0%');
    assert.equal(fmtNum(2.345), '2.35'); assert.equal(fmtNum(2.345, 1), '2.3'); assert.equal(fmtNum(null), '–');
  });

  test('見本の結果は種から決まり、RPC と同じ形に集計できる', () => {
    const now = JST(2026, 10, 12), rows = sampleRows('Me', now);
    assert.deepEqual(rows, sampleRows('Me', now));
    assert.ok(rows.every(r => MODE_IDS.includes(r.mode) && r.place >= 1 && r.place <= 6 && r.at <= now + 86_400_000 && r.vpip <= r.hands && r.pfr <= r.vpip));
    assert.ok(rows.some(r => r.k === demoKey('me') && r.name === 'Me'));
    for (const mode of MODE_IDS) {
      const d = aggregate(rows, { me: demoKey('me'), mode });
      assert.ok(d.seasons.length >= 3, mode);
      const all = memberRows(d, ALL), mine = rows.filter(r => r.mode === mode);
      assert.equal(all.reduce((a, r) => a + r.n, 0), mine.length);
      assert.ok(Math.abs(totalOf(all).pt - mine.reduce((a, r) => a + r.pt, 0)) < 1e-9);
      assert.deepEqual(ranking(all).map(r => r.rank)[0], 1);
    }
  });
});

/* ---------------- 部屋の決まり ---------------- */
// friend の部屋を最後まで打つ（全員オールイン／コール）。=> { room, recs }
function playRoom(kind, players, seed) {
  const rnd = seeded(seed), cfg = { ...DEFAULT_CONFIG, players, mode: 'rank-4' };
  let room = createRoom({ id: 'r', code: '123456', kind, uid: U(1), name: 'P1', config: cfg, now: 0, fx: 'gif-1' });
  for (let i = 2; i <= players; i++) room = joinRoom(room, U(i), `P${i}`, i, rnd, 'gif-2');
  const recs = [];
  let now = 1000;
  for (let guard = 0; guard < 4000 && room.status === 'running'; guard++) {
    now += 1000;
    const h = room.state.hand;
    let out;
    if (h.phase === 'settled') out = tickRoom(room, U(1), Math.max(now, room.state.nextAt));
    else {
      const L = legalActions(room.state, h.toAct);
      let type = L.canCheck ? 'check' : 'call';
      if (L.maxTo != null) type = 'allin';
      out = applyRequest(room, room.members[h.toAct], { op: 'act', ver: room.ver, move: { type } }, now);
    }
    room = out.room;
    if (out.record) recs.push(out.record.rec);
  }
  return { room, recs };
}

describe('FRIEND MATCH の部屋', () => {
  test('friend は部屋の種類の 1 つで、チャットと演出 GIF は PRIVATE MATCH と同じ（FREE MATCH には無い）', () => {
    assert.deepEqual(KINDS, ['private', 'free', 'friend']);
    assert.deepEqual(KINDS.map(social), [true, false, true]);
    let r = createRoom({ id: 'r', code: '000001', kind: 'friend', uid: U(1), name: 'A', config: { ...DEFAULT_CONFIG, players: 2 }, now: 0, fx: 'gif-a' });
    assert.deepEqual(r.fx, ['gif-a']);
    assert.throws(() => postChat(r, U(1), 'hi', null, 1), e => e.code === 'chat_closed');   // 開始前
    r = joinRoom(r, U(2), 'B', 1, seeded(3), 'gif-b');
    assert.equal(r.started, true);
    assert.deepEqual([...r.state.fx].sort((a, b) => a.localeCompare(b)), ['gif-a', 'gif-b']);
    assert.deepEqual(postChat(r, U(2), ' gl ', null, 5), { seat: r.members.indexOf(U(2)), text: 'gl' });
    const changed = setRoomFx(r, U(1), 'gif-c').room;
    assert.equal(changed.fx[r.members.indexOf(U(1))], 'gif-c'); assert.equal(changed.ver, r.ver + 1);
  });

  test('終局した friend の部屋から、席ごとの結果（順位・pt・ハンドの集計）が出る', () => {
    const { room, recs } = playRoom('friend', 4, 11);
    assert.equal(room.status, 'finished');
    const res = friendResults(room, recs);
    assert.equal(res.length, 4);
    assert.deepEqual(res.map(r => r.uid), room.members);
    assert.deepEqual(res.map(r => r.place).sort((a, b) => a - b), [1, 2, 3, 4]);
    const pay = payoutsFor(room.config);
    for (const r of res) {
      assert.equal(r.pt, pay[r.place - 1]);
      const seat = room.members.indexOf(r.uid), dealt = recs.filter(h => h.startStacks[seat] > 0).length;
      assert.equal(r.hands, dealt); assert.ok(r.hands >= 1 && r.vpip <= r.hands && r.pfr <= r.vpip);
    }
    assert.ok(res.some(r => r.vpip > 0));
  });

  test('friend でない部屋・終局していない部屋・中止は結果を残さない', () => {
    const priv = playRoom('private', 3, 5);
    assert.equal(priv.room.status, 'finished');
    assert.deepEqual(friendResults(priv.room, priv.recs), []);
    let r = createRoom({ id: 'r', code: '000002', kind: 'friend', uid: U(1), name: 'A', config: { ...DEFAULT_CONFIG, players: 2 }, now: 0 });
    assert.deepEqual(friendResults(r, []), []);
    assert.deepEqual(friendResults(leaveRoom(r, U(1), 1).room, []), []);   // 待機中に作成者が抜けて中止
    r = joinRoom(r, U(2), 'B', 1, seeded(7));
    assert.deepEqual(friendResults(r, []), []);
    // 途中で退出して終局：退出した人にも順位と pt が付く
    const left = leaveRoom(r, U(2), 2).room;
    assert.equal(left.status, 'finished');
    assert.deepEqual(friendResults(left, []).map(x => [x.uid, x.place, x.hands]).sort((a, b) => a[1] - b[1]), [[U(1), 1, 0], [U(2), 2, 0]]);
  });
});

/* ---------------- Discord の確認 ---------------- */
const CFG = { clientId: '111', clientSecret: 's3cret', guildId: '9000000001' };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
// Discord の代役。who = { id, roles } | null（メンバーでない）。呼び出しを calls に残す
function fakeDiscord(who, calls = [], opts = {}) {
  return async (url, init) => {
    calls.push({ url, init });
    if (opts.down) throw new Error('network');
    if (url.endsWith('/oauth2/token')) return opts.badCode ? json(400, { error: 'invalid_grant' }) : json(200, { access_token: 'tok-1', token_type: 'Bearer' });
    if (url.endsWith('/oauth2/token/revoke')) return json(200, {});
    if (url.includes('/users/@me/guilds/')) return who ? json(200, { user: { id: who.id }, roles: who.roles ?? [] }) : json(404, { message: 'Unknown Guild', code: 10004 });
    return json(500, {});
  };
}

describe('Discord のメンバー確認', () => {
  test('設定がそろっていなければ使えない', () => {
    assert.equal(makeDiscord({}), null);
    assert.equal(makeDiscord({ ...CFG, clientSecret: '' }), null);
    assert.equal(makeDiscord({ ...CFG, guildId: undefined }), null);
    assert.ok(makeDiscord(CFG));
  });

  test('同意の画面の URL：必要な scope だけ・戻り先・state', () => {
    const u = new URL(makeDiscord(CFG).authorizeUrl('https://app.example/', 'state-1234567890abcd'));
    assert.equal(u.origin + u.pathname, 'https://discord.com/oauth2/authorize');
    assert.deepEqual(Object.fromEntries(u.searchParams), { client_id: '111', response_type: 'code', scope: 'identify guilds.members.read', redirect_uri: 'https://app.example/', state: 'state-1234567890abcd', prompt: 'none' });
  });

  test('state はその人・その期限のものだけが合う（ほかの人・期限切れ・書き換え・別の鍵は合わない）', () => {
    const d = makeDiscord(CFG), now = 1_800_000_000_000, state = d.stateFor(U(1), now);
    assert.match(state, /^\d{13}\.[\w-]{43}$/);
    assert.equal(d.checkState(state, U(1), now), true);
    assert.equal(d.checkState(state, U(1), now + STATE_TTL_MS), true);
    assert.equal(d.checkState(state, U(1), now + STATE_TTL_MS + 1), false);   // 10 分で切れる
    assert.equal(d.checkState(state, U(2), now), false);                      // ほかの人に出したもの
    const [exp, sig] = state.split('.');
    assert.equal(d.checkState(`${+exp + 60_000}.${sig}`, U(1), now), false);  // 期限を書き換えた
    assert.equal(d.checkState(`${exp}.${sig.slice(0, -1)}A`, U(1), now), false);
    assert.equal(d.checkState(`${exp}.${sig}.x`, U(1), now), false);
    for (const bad of ['', 'x', '.', `${exp}.`, `.${sig}`, 'NaN.abc', null, undefined, 5]) assert.equal(d.checkState(bad, U(1), now), false, String(bad));
    // 先の日付の期限は、署名が合っていても通さない（出したのは今から 10 分以内のものだけ）
    assert.equal(d.checkState(d.stateFor(U(1), now + STATE_TTL_MS + 1), U(1), now), false);
    assert.equal(makeDiscord({ ...CFG, clientSecret: 'other' }).checkState(state, U(1), now), false);
  });

  test('メンバーなら鍵付きハッシュを返し、トークンは失効させる（ID もトークンも返さない）', async () => {
    const calls = [], d = makeDiscord({ ...CFG, fetcher: fakeDiscord({ id: '123456789012345678' }, calls) });
    const v = await d.verify('code-1', 'https://app.example/');
    assert.deepEqual(v, { member: true, key: createHmac('sha256', 's3cret').update('9000000001:123456789012345678').digest('hex') });
    assert.ok(!JSON.stringify(v).includes('123456789012345678'));
    assert.deepEqual(calls.map(c => new URL(c.url).pathname), ['/api/v10/oauth2/token', '/api/v10/users/@me/guilds/9000000001/member', '/api/v10/oauth2/token/revoke']);
    assert.ok(calls.every(c => new URL(c.url).origin === 'https://discord.com'));
    const tokenReq = new URLSearchParams(calls[0].init.body);
    assert.deepEqual(Object.fromEntries(tokenReq), { grant_type: 'authorization_code', code: 'code-1', redirect_uri: 'https://app.example/' });
    assert.equal(calls[0].init.headers.Authorization, 'Basic ' + Buffer.from('111:s3cret').toString('base64'));
    assert.equal(calls[1].init.headers.Authorization, 'Bearer tok-1');
    assert.equal(new URLSearchParams(calls[2].init.body).get('token'), 'tok-1');
    // 同じ人は同じ鍵、別の人・別のサーバーは別の鍵
    assert.equal((await d.verify('code-2', 'https://app.example/')).key, v.key);
    const other = await makeDiscord({ ...CFG, fetcher: fakeDiscord({ id: '223456789012345678' }) }).verify('c', 'https://app.example/');
    const guild = await makeDiscord({ ...CFG, guildId: '9000000002', fetcher: fakeDiscord({ id: '123456789012345678' }) }).verify('c', 'https://app.example/');
    assert.notEqual(other.key, v.key); assert.notEqual(guild.key, v.key);
  });

  test('サーバーに居ない人・ロールの無い人はメンバーでない（トークンは失効させる）', async () => {
    const calls = [];
    assert.deepEqual(await makeDiscord({ ...CFG, fetcher: fakeDiscord(null, calls) }).verify('c', 'https://app.example/'), { member: false });
    assert.equal(calls.length, 3);
    const role = { ...CFG, roleId: '777' };
    assert.deepEqual(await makeDiscord({ ...role, fetcher: fakeDiscord({ id: '123456', roles: ['1', '2'] }) }).verify('c', 'https://app.example/'), { member: false });
    assert.equal((await makeDiscord({ ...role, fetcher: fakeDiscord({ id: '123456', roles: ['1', '777'] }) }).verify('c', 'https://app.example/')).member, true);
  });

  test('code が正しくない・Discord に届かない・おかしな応答は discord_failed', async () => {
    const failed = e => e.code === 'discord_failed';
    await assert.rejects(makeDiscord({ ...CFG, fetcher: fakeDiscord({ id: '123456' }, [], { badCode: true }) }).verify('c', 'https://app.example/'), failed);
    await assert.rejects(makeDiscord({ ...CFG, fetcher: fakeDiscord({ id: '123456' }, [], { down: true }) }).verify('c', 'https://app.example/'), failed);
    await assert.rejects(makeDiscord({ ...CFG, fetcher: fakeDiscord({ id: 'not-a-snowflake' }) }).verify('c', 'https://app.example/'), failed);
    const calls = [];
    await assert.rejects(makeDiscord({ ...CFG, fetcher: fakeDiscord({ id: '<script>' }, calls) }).verify('c', 'https://app.example/'), failed);
    assert.equal(calls.length, 3);   // 失敗してもトークンは失効させる
  });
});

/* ---------------- HTTP ---------------- */
describe('HTTP：Discord の確認', () => {
  const calls = [];
  const h = createHandler({
    allowedOrigins: ['https://app.example'], verifyToken: async t => (t === 'good' ? U(1) : null), logError: () => {},
    discordStart: async (uid, redirect) => { calls.push(['start', uid, redirect]); return { url: 'https://discord.com/oauth2/authorize?x=1' }; },
    discordLink: async (uid, ret, redirect) => { calls.push(['link', uid, ret, redirect]); return { ok: true, until: 1 }; },
  });
  const post = async (body, origin = 'https://app.example', token = 'good') => {
    const r = await h(new Request('https://f/', { method: 'POST', headers: { Authorization: `Bearer ${token}`, ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) }));
    return [r.status, await r.json()];
  };

  test('戻り先はこのサイトの入口だけ。code と state の形を確かめる', async () => {
    const state = '1800000000000.abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE', code = 'AbC-123_xyz';
    assert.deepEqual(await post({ op: 'discord_start' }), [200, { url: 'https://discord.com/oauth2/authorize?x=1' }]);
    assert.deepEqual(calls.at(-1), ['start', U(1), 'https://app.example/']);
    assert.deepEqual(await post({ op: 'discord_link', code, state }), [200, { ok: true, until: 1 }]);
    assert.deepEqual(calls.at(-1), ['link', U(1), { code, state }, 'https://app.example/']);
    const n = calls.length;
    for (const body of [{ op: 'discord_link' }, { op: 'discord_link', code }, { op: 'discord_link', state }, { op: 'discord_link', code: 'x', state }, { op: 'discord_link', code: 'a&b=c0123456', state },
      { op: 'discord_link', code: 'x'.repeat(129), state }, { op: 'discord_link', code, state: 'abcdef0123456789abcdef0123456789' }, { op: 'discord_link', code, state: '1800000000000.has space 0123456789abcdef' }, { op: 'discord_link', code, state: 5 }])
      assert.deepEqual(await post(body), [422, { error: 'malformed' }], JSON.stringify(body));
    // 許可していない Origin・Origin 無しからは始められない
    assert.equal((await post({ op: 'discord_start' }, 'https://evil.example'))[0], 422);
    assert.equal((await post({ op: 'discord_link', code, state }, null))[0], 422);
    assert.equal((await post({ op: 'discord_link', code, state }, 'https://app.example', 'bad'))[0], 401);
    assert.equal(calls.length, n);
  });

  test('エラーの対応', () => {
    assert.deepEqual([STATUS.not_friend, STATUS.not_member, STATUS.friend_off, STATUS.discord_failed], [403, 403, 503, 502]);
  });
});

/* ---------------- DB の結合テスト ---------------- */
describe('FRIEND MATCH（専用 DB）', { skip: !DBURL && 'TEST_DATABASE_URL が無い' }, () => {
  let T, clock, who, db;
  // Discord の代役：code がそのまま Discord の利用者（'out' はサーバーに居ない人）。state は本物（discord.js）と同じ作り
  const real = makeDiscord(CFG);
  const discord = {
    stateFor: real.stateFor, checkState: real.checkState,
    authorizeUrl: (redirect, state) => `https://discord.example/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirect)}`,
    verify: async code => (code === 'out' ? { member: false } : { member: true, key: `key-${code}` }),
  };
  const SITE = 'https://app.example/';
  const link = (uid, code, to = db) => to.discordLink(uid, { code, state: real.stateFor(uid, clock.t) }, SITE);
  const members = async () => (await T.pool.query('select uid, discord_key from public.friend_members order by discord_key')).rows.map(r => [r.uid, r.discord_key]);
  const results = async room => (await T.pool.query('select uid, mode, players, place, pt::float8 as pt, hands, vpip, pfr from public.friend_results where room=$1 order by place', [room])).rows;
  const code = e => e.code;

  before(async () => {
    T = await openTestDb('friend');
    clock = { t: Date.now() };
    db = makeDb(T.pool, { now: () => clock.t, rnd: seeded(42), discord });
    who = await T.newUsers(6);
  });
  after(async () => { await T?.close(); });

  test('権限：表は読めず、補助の関数は呼べない。RPC は friend_stats だけが authenticated に開く', async () => {
    for (const t of ['friend_members', 'friend_results']) {
      const { rows: [c] } = await T.pool.query('select relrowsecurity from pg_class where oid = $1::regclass', [`public.${t}`]);
      assert.equal(c.relrowsecurity, true, t);
      for (const role of ['authenticated', 'anonymous'])
        await assert.rejects(T.as(role, { sub: who[0], role }, `select * from public.${t}`), e => e.code === '42501', `${role} ${t}`);
    }
    for (const fn of ['friend_ttl()', `friend_ok('${who[0]}')`, `friend_key('${who[0]}')`, 'friend_season(now())'])
      await assert.rejects(T.as('authenticated', { sub: who[0], role: 'authenticated' }, `select public.${fn}`), e => e.code === '42501', fn);
    await assert.rejects(T.as('anonymous', { sub: who[0], role: 'authenticated' }, "select public.friend_stats('club', null)"), e => e.code === '42501');
  });

  test('Discord で確認していない人は、部屋を作れず・入れず・スタッツも読めない', async () => {
    const [a, b] = who;
    assert.equal((await T.rpc(a, 'me')).friend, null);
    await assert.rejects(db.create(a, 'friend', DEFAULT_CONFIG), e => code(e) === 'not_friend');
    await assert.rejects(T.rpc(a, 'friend_stats', ['club', null]), /not_friend/);
    // 確認の開始：state はその人のもの。ほかの人の state・期限切れの state では確認できず、Discord にも問い合わせない
    const url = new URL((await db.discordStart(a, SITE)).url), state = url.searchParams.get('state');
    assert.equal(url.searchParams.get('redirect_uri'), SITE); assert.equal(real.checkState(state, a, clock.t), true);
    await assert.rejects(db.discordLink(b, { code: 'bob', state }, SITE), e => code(e) === 'discord_failed');
    clock.t += 10 * 60_000 + 1;
    await assert.rejects(db.discordLink(a, { code: 'alice', state }, SITE), e => code(e) === 'discord_failed');
    assert.deepEqual(await members(), []);
    assert.equal((await T.pool.query("select count(*)::int as n from public.rate_limits where kind='discord'")).rows[0].n, 0);
    const linked = await link(a, 'alice');
    assert.equal(linked.ok, true); assert.ok(Math.abs(linked.until - (Date.now() + 30 * 86_400_000)) < 120_000);
    const f = (await T.rpc(a, 'me')).friend;
    assert.equal(f.ok, true); assert.equal(f.until, linked.until);
    const r = await db.create(a, 'friend', { ...DEFAULT_CONFIG, players: 2 });
    assert.equal(r.view.room.kind, 'friend');
    // 部屋番号を知っていても、確認していない人は入れない（概要は見える）
    assert.equal((await T.rpc(b, 'room_peek', [r.view.room.code])).kind, 'friend');
    await assert.rejects(db.join(b, r.view.room.code), e => code(e) === 'not_friend');
    await db.leave(a, r.room);
    // PRIVATE MATCH・FREE MATCH は確認が要らない
    const p = await db.create(b, 'private', DEFAULT_CONFIG);
    await db.leave(b, p.room);
  });

  test('同じ Discord アカウントは 1 人だけ。サーバーを抜けた人は確認が消える。設定が無ければ friend_off', async () => {
    const [a, b, c] = who;
    await link(a, 'alice'); await link(b, 'bob');
    assert.deepEqual(await members(), [[a, 'key-alice'], [b, 'key-bob']]);
    // c が alice の Discord で確認すると、a の確認は外れる
    await link(c, 'alice');
    assert.deepEqual(await members(), [[c, 'key-alice'], [b, 'key-bob']]);
    assert.equal((await T.rpc(a, 'me')).friend, null);
    // 確かめ直しても行は増えない
    await link(b, 'bob');
    assert.equal((await members()).length, 2);
    await assert.rejects(link(b, 'out'), e => code(e) === 'not_member');
    assert.deepEqual(await members(), [[c, 'key-alice']]);
    const off = makeDb(T.pool, { now: () => clock.t });
    await assert.rejects(off.discordStart(a, SITE), e => code(e) === 'friend_off');
    await assert.rejects(link(a, 'alice', off), e => code(e) === 'friend_off');
    await assert.rejects(link(randomUUID(), 'ghost'), e => code(e) === 'no_profile');
  });

  test('確認は 30 日で切れる', async () => {
    const [a] = who;
    await link(a, 'alice2');
    await T.pool.query("update public.friend_members set verified_at = now() - interval '29 days 23 hours' where uid=$1", [a]);
    assert.equal((await T.rpc(a, 'me')).friend.ok, true);
    await T.pool.query("update public.friend_members set verified_at = now() - interval '30 days 1 minute' where uid=$1", [a]);
    assert.equal((await T.rpc(a, 'me')).friend.ok, false);
    await assert.rejects(db.create(a, 'friend', DEFAULT_CONFIG), e => code(e) === 'not_friend');
    await assert.rejects(T.rpc(a, 'friend_stats', ['club', null]), /not_friend/);
    await link(a, 'alice2');
    assert.equal((await T.rpc(a, 'me')).friend.ok, true);
  });

  test('確認の回数は 10 分に 10 回まで（Discord に問い合わせる前に数える）', async () => {
    const [, , , , , f] = who;
    let asked = 0;
    const counting = makeDb(T.pool, { now: () => clock.t, discord: { ...discord, verify: async () => { asked++; return { member: false }; } } });
    for (let i = 0; i < 10; i++) await assert.rejects(link(f, 'out', counting), e => code(e) === 'not_member');
    await assert.rejects(link(f, 'out', counting), e => code(e) === 'too_many');
    assert.equal(asked, 10);
    await T.pool.query("update public.rate_limits set since = now() - interval '11 minutes' where uid=$1 and kind='discord'", [f]);
    await assert.rejects(link(f, 'out', counting), e => code(e) === 'not_member');
  });

  test('終局した FRIEND MATCH の結果が残り、スタッツの RPC は見本の集計と一致する。PRIVATE MATCH は残さない', async () => {
    const [a, b, c, d] = who, us = [a, b, c];
    for (const [i, u] of us.entries()) await link(u, `player-${i}`);
    const cfg = { ...DEFAULT_CONFIG, players: 3, mode: 'rank-3' };
    const made = await db.create(a, 'friend', cfg, 'gif-a');
    await db.join(b, made.view.room.code);
    const started = await db.join(c, made.view.room.code);
    assert.equal(started.view.status, 'running');
    // チャットも PRIVATE MATCH と同じ
    const said = await db.chat(a, made.room, 'gl');
    assert.deepEqual((await T.rpc(b, 'room_chat', [made.room, 0])).map(m => [m.seq, m.text]), [[said.msg.seq, 'gl']]);
    assert.deepEqual(await results(made.room), []);   // 終わるまでは無い
    const fin = await playOut({ db, rpc: T.rpc }, made.room, us, clock);
    assert.equal(fin.status, 'finished');
    const res = await results(made.room), pay = payoutsFor(cfg);
    assert.equal(res.length, 3);
    assert.deepEqual(res.map(r => [r.mode, r.players, r.place, r.pt]), [1, 2, 3].map(p => ['rank-3', 3, p, pay[p - 1]]));
    for (const r of res) {
      const view = (await T.rpc(r.uid, 'room_poll', [made.room, -1])).view, mine = view.players[view.seat];
      assert.deepEqual([r.place, r.pt], [mine.place, mine.pt]);
      const hands = await T.rpc(r.uid, 'room_hands', [made.room, 0]);
      assert.equal(r.hands, hands.filter(h => h.startStacks[view.seat] > 0).length);
      assert.ok(r.hands >= 1 && r.vpip <= r.hands && r.pfr <= r.vpip);
    }
    // 終局後の操作（席に残る・去る）で二重に残らない
    await db.stay(a, made.room); await db.leave(b, made.room);
    assert.equal((await results(made.room)).length, 3);
    // PRIVATE MATCH の結果は残さない
    const priv = await db.create(a, 'private', { ...DEFAULT_CONFIG, players: 2 });
    await db.join(d, priv.view.room.code);
    assert.equal((await playOut({ db, rpc: T.rpc }, priv.room, [a, d], clock)).status, 'finished');
    assert.deepEqual(await results(priv.room), []);

    // ほかのシーズン・ほかのモードの結果を足して、RPC と見本の集計（src/friendDemo.js の aggregate）を突き合わせる
    const add = (uid, mode, at, place, pt) => T.pool.query('insert into public.friend_results(room,uid,mode,players,place,pt,hands,vpip,pfr,ended_at) values($1,$2,$3,3,$4,$5,30,9,6,$6)', [randomUUID(), uid, mode, place, pt, new Date(at)]);
    await add(a, 'rank-3', JST(2026, 8, 31, 23), 1, 25); await add(b, 'rank-3', JST(2026, 8, 31, 23), 2, 15);
    await add(a, 'rank-3', JST(2026, 9, 1, 0), 3, 5); await add(c, 'rank-3', JST(2026, 9, 1, 0), 1, 25);   // 日本時間の月初は次のシーズン
    await add(a, 'legend-avg', JST(2026, 9, 5), 1, 37.5); await add(b, 'legend-avg', JST(2026, 9, 5), 2, 18);
    const rows = (await T.pool.query(`select public.friend_key(r.uid) as k, p.nickname as name, r.mode, (extract(epoch from r.ended_at) * 1000)::float8 as at,
        r.place, r.pt::float8 as pt, r.hands, r.vpip, r.pfr from public.friend_results r join public.profiles p on p.uid = r.uid`)).rows.map(r => ({ ...r, at: Math.floor(r.at) }));
    const keyOf = async u => (await T.pool.query('select public.friend_key($1) as k', [u])).rows[0].k;
    const sortAgg = l => [...l].sort((x, y) => `${x.s}|${x.k}`.localeCompare(`${y.s}|${y.k}`));
    const sortBy = (l, f) => [...l].sort((x, y) => f(x).localeCompare(f(y)));
    for (const [mode, season] of [['rank-3', null], ['rank-3', '2026-08'], ['rank-3', '2026-09'], ['rank-3', 'bogus'], ['legend-avg', null], ['club', null]]) {
      const got = await T.rpc(a, 'friend_stats', [mode, season]), want = aggregate(rows, { me: await keyOf(a), mode, season });
      assert.deepEqual([got.me, got.mode, got.season, got.seasons], [want.me, mode, want.season, want.seasons], `${mode} ${season}`);
      assert.deepEqual(sortBy(got.members, m => m.k), sortBy(want.members, m => m.k));
      assert.deepEqual(sortAgg(got.agg), sortAgg(want.agg));
      assert.deepEqual(sortBy(got.games, g => `${g.at}|${g.k}`), sortBy(want.games, g => `${g.at}|${g.k}`));
    }
    const stats = await T.rpc(a, 'friend_stats', ['rank-3', null]);
    assert.deepEqual(stats.seasons.slice(0, 2), ['2026-08', '2026-09']);
    assert.equal(stats.season, stats.seasons.at(-1));
    assert.deepEqual(ranking(memberRows(stats, '2026-08')).map(r => [r.rank, r.pt]), [[1, 25], [2, 15]]);
    assert.ok(!JSON.stringify(stats).includes(a));   // uid そのものは返さない
    // 部屋が消えても結果は残る。利用者が消えると結果も消える
    await T.pool.query('delete from public.rooms where id=$1', [made.room]);
    assert.equal((await results(made.room)).length, 3);
    await T.pool.query('delete from neon_auth."user" where id=$1', [c]);
    assert.equal((await results(made.room)).length, 2);
  });
});
