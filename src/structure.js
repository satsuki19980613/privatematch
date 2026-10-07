// SIT & GO の設定（ポーカーチェイスのストラクチャー）。pocket-ICM の packages/sng/src/types.ts・structure.ts と
// packages/core/src/blindStructure.ts・gameMode.ts をそのまま移したもの。ブラウザとサーバーの両方が読む。
// 単位はチップ。レベル 1 の BB = 200 チップ。表示の bb 換算は画面側だけで行う。

/** 人数（作成者が選ぶ。揃った瞬間に自動で始まる） */
export const PLAYER_COUNTS = [2, 3, 4, 5, 6];
/** 初期チップ（BB）。チップは × BASE_BB = 10000 / 15000 / 20000 / 30000 枚 */
export const START_BBS = [50, 75, 100, 150];
/** ブラインド構造（ゲームに登録されている 3 種） */
export const SPEEDS = ['normal', 'slow', 'veryslow'];
/** 1 レベルの長さ。ポーカーチェイスは全ストラクチャー 3 分（上昇間隔は選べない） */
export const LEVEL_MS = 3 * 60000;
/** レベル 1 の BB（チップ） */
export const BASE_BB = 200;

export const SPEED_LABEL = { normal: '通常', slow: 'ゆっくり', veryslow: 'もっとゆっくり' };

/** 公式「通常」表 [BB, ante]（16 レベル） */
const BLIND_TABLE_NORMAL = [
  [200, 50], [280, 70], [400, 100], [560, 140], [780, 200], [1100, 280], [1640, 410], [2500, 630],
  [3800, 950], [5700, 1400], [8600, 2200], [13000, 3200], [19600, 4900], [29500, 7400], [44300, 11000],
  [60000, 15000],
];
/** 公式「ゆっくり」表 [BB, ante]（32 レベル） */
const BLIND_TABLE_SLOW = [
  [200, 50], [240, 60], [300, 75], [360, 90], [440, 110], [540, 140], [660, 170], [800, 200],
  [960, 240], [1200, 300], [1440, 360], [1700, 430], [2000, 500], [2400, 600], [2900, 730],
  [3500, 880], [4200, 1100], [5000, 1300], [6000, 1500], [7200, 1800], [8700, 2200], [10000, 2500],
  [12000, 3000], [14000, 3500], [17000, 4300], [20000, 5000], [24000, 6000], [29000, 7300],
  [35000, 8800], [42000, 11000], [50000, 13000], [60000, 15000],
];
/** 公式「もっとゆっくり」表 [BB, ante]（59 レベル） */
const BLIND_TABLE_VERY_SLOW = [
  [200, 50], [220, 55], [240, 60], [260, 65], [300, 70], [320, 80], [360, 90], [400, 100],
  [440, 110], [480, 120], [540, 140], [600, 150], [660, 170], [740, 190], [820, 210], [900, 230],
  [1000, 250], [1100, 280], [1200, 300], [1320, 330], [1500, 380], [1700, 430], [1900, 480],
  [2100, 530], [2300, 580], [2500, 630], [2800, 700], [3100, 780], [3400, 860], [3700, 930],
  [4100, 1000], [4500, 1100], [5000, 1300], [5500, 1400], [6100, 1500], [6700, 1700], [7400, 1900],
  [8100, 2000], [9000, 2300], [10000, 2500], [11000, 2800], [12000, 3000], [13000, 3300],
  [14000, 3500], [15000, 3800], [17000, 4300], [19000, 4800], [21000, 5300], [23000, 5800],
  [25000, 6300], [28000, 7000], [31000, 7800], [34000, 8500], [38000, 9500], [42000, 11000],
  [46000, 12000], [50000, 13000], [55000, 14000], [60000, 15000],
];
export const BLIND_TABLES = { normal: BLIND_TABLE_NORMAL, slow: BLIND_TABLE_SLOW, veryslow: BLIND_TABLE_VERY_SLOW };

/** そのスピードの全レベル（1 始まり）。SB は BB/2、アンティは表の値を全員が払う */
export function levelsOf(speed) {
  return BLIND_TABLES[speed].map(([bb, ante], i) => ({ level: i + 1, sb: bb / 2, bb, ante }));
}
/** レベル番号 → ブラインド（表の長さを超えたら最終レベル。1 未満は 1） */
export function blindsAt(speed, level) {
  const t = BLIND_TABLES[speed];
  const i = Math.min(t.length, Math.max(1, Math.floor(level))) - 1;
  const [bb, ante] = t[i];
  return { level: i + 1, sb: bb / 2, bb, ante };
}
/** 1 レベルの長さ（ms）。上昇間隔を選べた頃の部屋（config.levelMin）はその値のまま */
export const levelMsOf = config => (config.levelMin ? config.levelMin * 60000 : LEVEL_MS);
/** 次のハンドのレベル。ポーカーチェイスと同じく、レベルが始まってから 1 レベルの長さが過ぎていれば
 *  次のハンドから 1 つ上げ、タイマーはそのハンドの開始から数え直す（ハンドの途中では上がらない）。
 *  level = いまのレベル、levelStartAt = いまのレベルが始まった時刻 → { level, levelStartAt } */
export function nextLevel(config, level, levelStartAt, now) {
  if (level < BLIND_TABLES[config.speed].length && now - levelStartAt >= levelMsOf(config)) return { level: level + 1, levelStartAt: now };
  return { level, levelStartAt };
}

// ゲームモード（順位別ポイント）。pocket-ICM の GAME_MODE_SPECS の payouts。ブラインドは全モード共通。
const LEGEND_SEASON = [40, 15, 3, 0, -18, -40];
const LEGEND_BASE = [35, 21, 7, -7, -21, -35];
const LEGEND_AVG = LEGEND_SEASON.map((v, i) => (v + LEGEND_BASE[i]) / 2);
export const GAME_MODES = {
  club: { kind: 'club', game: 'クラブ', variant: null, payouts: [5, 3, 2, 1, 0, -1] },
  'rank-3': { kind: 'rank', game: 'ランク', variant: 'Ⅲ', payouts: [25, 15, 5, -2, -8, -15] },
  'rank-4': { kind: 'rank', game: 'ランク', variant: 'Ⅳ', payouts: [30, 18, 6, -4, -13, -20] },
  'rank-5': { kind: 'rank', game: 'ランク', variant: 'Ⅴ', payouts: [35, 21, 7, -6, -19, -28] },
  'legend-avg': { kind: 'legend', game: 'レジェンド', variant: '平均', payouts: LEGEND_AVG },
  'legend-season': { kind: 'legend', game: 'レジェンド', variant: 'シーズン', payouts: LEGEND_SEASON },
  'legend-base': { kind: 'legend', game: 'レジェンド', variant: 'ベース', payouts: LEGEND_BASE },
};
export const MODE_IDS = Object.keys(GAME_MODES);
export const GAME_KINDS = ['club', 'rank', 'legend'];
export const GAME_KIND_LABELS = { club: 'クラブ', rank: 'ランク', legend: 'レジェンド' };
export const MODES_BY_KIND = {
  club: ['club'],
  rank: ['rank-3', 'rank-4', 'rank-5'],
  legend: ['legend-avg', 'legend-season', 'legend-base'],
};
/** 表示用のモード名（「ランクマッチ STAGE Ⅳ」「レジェンドマッチ（平均）」の形） */
export function modeLabel(mode) {
  const s = GAME_MODES[mode] || GAME_MODES.club;
  if (s.kind === 'rank') return `ランクマッチ STAGE ${s.variant}`;
  if (s.kind === 'legend') return `レジェンドマッチ（${s.variant}）`;
  return 'クラブマッチ';
}
/** その部屋の順位 → pt（残り n 人では先頭 n 個） */
export function payoutsFor(config) {
  return (GAME_MODES[config.mode] || GAME_MODES.club).payouts.slice(0, config.players);
}

export const DEFAULT_CONFIG = { players: 6, startBb: 100, speed: 'normal', mode: 'club' };

/** 受け取った設定を検証して正規化する。不正なら null（以前の levelMin は受け取っても捨てる） */
export function normalizeConfig(c) {
  if (!c || typeof c !== 'object') return null;
  const out = { players: c.players, startBb: c.startBb, speed: c.speed, mode: c.mode };
  if (!PLAYER_COUNTS.includes(out.players) || !START_BBS.includes(out.startBb) || !SPEEDS.includes(out.speed) ||
    !MODE_IDS.includes(out.mode)) return null;
  return out;
}
/** 初期チップの表示（「20,000枚」） */
export const chipsLabel = startBb => `${(startBb * BASE_BB).toLocaleString('en-US')}枚`;
/** 試合の見出し（人数・初期チップ・構造・モード。上昇間隔を選べた頃の試合はその分数も） */
export function configSummary(c) {
  return `${c.players}人 ・ ${chipsLabel(c.startBb)} ・ ${SPEED_LABEL[c.speed]}${c.levelMin ? ` ・ ${c.levelMin}分上昇` : ''} ・ ${modeLabel(c.mode)}`;
}

// 時間の定数（ms）
export const ACTION_MS = 15000;               // 1 アクションの持ち時間
export const TIME_BANK_MS = 30000;            // 1 試合のタイムバンク（補充なし）
export const AUTO_TO_SITOUT = 2;              // 自動処理がこの回数連続したら sitout
export const BETWEEN_HANDS_MS = 3000;         // ハンド間（結果表示）
export const WAITING_EXPIRES_MS = 15 * 60000; // 募集の期限
export const REMATCH_MS = 15 * 60000;         // 終局後の再戦の受付
export const REMATCH_HOST_WAIT_MS = 60000;    // 作成者が「席に残る」を押さないまま、この時間たったら残った人が再戦を始められる

// ショーダウン（オールインのランアウトを含む）の見せ方の時間（ms）。卓の画面がこの順に見せ、エンジンは次のハンドをその分だけ遅らせる。
//   gather ベットをポットへ集める（ALL-IN の帯）→ reveal 手札を表に返して勝率を読ませる → flop / street フロップ・ターンを開いて勝率を更新して止める
//   （gather と flop は、速すぎるという声で 1.8 倍にした。もとは 500 / 1700）
//   → river リバー（勝負が残っていれば伏せて置いてからゆっくりめくり、勝率が決まるまで）→ 勝者・ポットの移動（BETWEEN_HANDS_MS）。
//   普通のショーダウン（from = 5）は gather → show（手札を表にして見せる）→ 結果。
//   勝負が決まってから結果へは間をおかずに進む（一間おくのは勝者の演出 GIF を出すときだけ。FX.wait）
//   latency はポーリング（最大 1 秒）で遅れて見始めた人の分。他アプリのストリート間隔は 1〜3 秒（中央値 2 秒前後）で、1 秒以下だと何が起きたか分からない
export const RUNOUT = { gather: 900, reveal: 1400, flop: 3060, street: 1700, river: 2000, show: 800, latency: 800 };
/** ショーダウンの演出の長さ。from = 手札を表にした時点のボードの枚数（0/3/4/5。オールインでなければ 5）、null はショーダウン無し */
export function runoutMs(from) {
  if (from == null) return 0;
  const R = RUNOUT;
  if (from >= 5) return R.gather + R.show + R.latency;
  return R.gather + R.reveal + (from < 3 ? R.flop : 0) + (from < 4 ? R.street : 0) + R.river + R.latency;
}
// 勝者の演出 GIF（PRIVATE MATCH だけ。engine.js の fxSeat）。ショーダウンで勝負が決まって一間（wait）おいてから卓の中央に出し、
//   消してボードに戻ってから、ポットを勝者へ動かす。wait 一間 / in 出る / show 見せる / out 消える / gap ボードに戻ってからチップが動くまで。
//   GIF を出さないハンドは一間もおかない
//   （out と gap は、消えてからが速すぎるという声で 1.8 倍にした。もとは 320 / 250）。
//   出す席があるハンドは、エンジンが次のハンドを FX_MS だけ遅らせる
export const FX = { wait: 600, in: 280, show: 2600, out: 576, gap: 450 };
export const FX_MS = FX.wait + FX.in + FX.show + FX.out + FX.gap;
export const PAUSED_EXPIRES_MS = 10 * 60000;  // 一時停止の期限
