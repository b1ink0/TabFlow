import { chromium } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'public/icons');
const source = await readFile(path.join(directory, 'mark.svg'), 'utf8');
if (!source.includes('rx="28"')) throw Error('Expected the rounded master icon background.');
const maskable = source.replace('rx="28"', '');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [size, markup, name] of [
    ...[16, 32, 48, 128].map((size) => [size, source, `${size}.png`]),
    [512, maskable, 'maskable-512.png'],
  ]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<html><head><style>html,body{margin:0;background:transparent}img{display:block;width:100%;height:100%}</style></head><body><img alt="TabFlow" src="data:image/svg+xml;base64,${Buffer.from(markup).toString('base64')}"></body></html>`,
    );
    await page.locator('img').evaluate((image) => image.decode());
    await page.screenshot({ path: path.join(directory, name), omitBackground: true });
  }
  await page.setViewportSize({ width: 880, height: 440 });
  const image = `data:image/svg+xml;base64,${Buffer.from(source).toString('base64')}`;
  const adaptive = `data:image/svg+xml;base64,${Buffer.from(maskable).toString('base64')}`;
  await page.setContent(
    `<html><head><style>*{box-sizing:border-box}html,body{margin:0;font:14px system-ui}.preview{display:flex;height:440px}.surface{display:flex;width:440px;flex-direction:column;gap:32px;padding:32px}.dark{background:#202020;color:#fff}.light{background:#f5f5f5;color:#202020}.sizes,.masks{display:flex;align-items:center;gap:24px}.sample{display:flex;flex-direction:column;align-items:center;gap:12px}img{display:block}.circle{border-radius:50%}.squircle{border-radius:28%}h1{margin:0;font-size:22px}p{margin:0;opacity:.7}</style></head><body><div class="preview">${['dark', 'light'].map((theme) => `<section class="surface ${theme}"><h1>TabFlow</h1><div class="sizes">${[16, 32, 48, 128].map((size) => `<div class="sample"><img alt="${size}px icon" width="${size}" height="${size}" src="${image}"><span>${size}px</span></div>`).join('')}</div><div class="masks"><img alt="Circular crop" class="circle" width="64" height="64" src="${adaptive}"><img alt="Rounded crop" class="squircle" width="64" height="64" src="${adaptive}"><img alt="Square crop" width="64" height="64" src="${adaptive}"></div><p>Crop-safe maskable asset</p></section>`).join('')}</div></body></html>`,
  );
  await page
    .locator('img')
    .evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
  await mkdir(path.join(root, 'artifacts'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'artifacts/app-icon-preview.png') });
  console.log('Generated extension PNGs, the maskable asset and light/dark size previews.');
} finally {
  await browser.close();
}
