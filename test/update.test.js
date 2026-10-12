// アプリの自動更新の判断（src/update.js）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { entryOf, isStale, mayReload, RELOAD_GAP_MS, CHECK_MS } from '../src/update.js';

test('入口のスクリプト：index.html からもスクリプトの URL からも同じパスが取れる。無ければ null', () => {
  const html = '<!doctype html><script src="/theme.js"></script><script type="module" crossorigin src="/assets/index-D6524lXY.js"></script><link rel="stylesheet" href="/assets/index-BKuOtgwe.css">';
  assert.equal(entryOf(html), '/assets/index-D6524lXY.js');
  assert.equal(entryOf('/assets/index-D6524lXY.js'), '/assets/index-D6524lXY.js');
  assert.equal(entryOf('https://privatematch.pages.dev/assets/index-a_B-9.js'), '/assets/index-a_B-9.js');
  // 開発サーバーの入口・ほかの部品・壊れた応答は入口として扱わない
  for (const bad of ['<script type="module" src="/src/main.js"></script>', '/assets/rules-Z6-sRbu8.js', '/assets/index-BKuOtgwe.css', '', null, undefined, 5, {}])
    assert.equal(entryOf(bad), null, String(bad));
});

test('開発中の index.html の入口は /src/main.js（自動更新は本番のビルドでだけ働く）', () => {
  assert.equal(entryOf(readFileSync(new URL('../index.html', import.meta.url), 'utf8')), null);
});

test('新しい版：入口が違うときだけ。どちらかが分からなければ読み込み直さない', () => {
  assert.equal(isStale('/assets/index-a.js', '/assets/index-b.js'), true);
  assert.equal(isStale('/assets/index-a.js', '/assets/index-a.js'), false);
  assert.equal(isStale(null, '/assets/index-b.js'), false);   // 開発サーバー
  assert.equal(isStale('/assets/index-a.js', null), false);   // index.html が読めなかった・入口が見つからなかった
  assert.equal(isStale(null, null), false);
});

test('読み込み直しは 5 分に 1 回まで（前の時刻が無い・壊れている・時計が戻ったときは止めない）', () => {
  const now = 1_800_000_000_000;
  for (const none of [null, undefined, 0, Number.NaN, -1]) assert.equal(mayReload(none, now), true, String(none));
  assert.equal(mayReload(now - 1000, now), false);
  assert.equal(mayReload(now - RELOAD_GAP_MS + 1, now), false);
  assert.equal(mayReload(now - RELOAD_GAP_MS, now), true);
  assert.equal(mayReload(now + 60_000, now), true);
  assert.ok(CHECK_MS >= 60_000 && RELOAD_GAP_MS >= 60_000);
});
