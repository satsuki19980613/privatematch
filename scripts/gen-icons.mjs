// public/icon.svg からホーム画面用の PNG を作る：node scripts/gen-icons.mjs
// 描画には Playwright の Chromium を使う（このリポジトリは依存しない。PLAYWRIGHT_MODULE で @playwright/test か playwright の index.mjs を指す）。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PUBLIC = resolve(import.meta.dirname, '../public');
const mod = process.env.PLAYWRIGHT_MODULE;
if (!mod) { console.error('PLAYWRIGHT_MODULE=<playwright の index.mjs> が必要です'); process.exit(2); }
const { chromium } = await import(pathToFileURL(mod).href);
const svg = readFileSync(resolve(PUBLIC, 'icon.svg'), 'utf8');
// maskable（Android が丸や角丸に切る）：背景はそのまま、<g id="mark"> だけ 80% の安全域に縮める
const maskable = svg.replace('<g id="mark">', '<g id="mark" transform="translate(50 50) scale(.8) translate(-50 -50)">');
const browser = await chromium.launch();
try {
  for (const [file, size, src] of [['apple-touch-icon.png', 180, svg], ['icon-192.png', 192, svg], ['icon-512.png', 512, svg], ['icon-maskable-512.png', 512, maskable]]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<html><body style="margin:0">${src.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: resolve(PUBLIC, file) });
    await page.close(); console.log(`${file} (${size})`);
  }
} finally { await browser.close(); }
