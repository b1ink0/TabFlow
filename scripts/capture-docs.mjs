import { chromium } from '@playwright/test';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const chromiumPath = process.env.TABFLOW_CHROMIUM_PATH || process.env.TABLOOM_CHROMIUM_PATH;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'docs/images');
const builtAt = (await stat(path.join(root, '.output/chrome-mv3/manifest.json'))).mtimeMs;
execFileSync(process.execPath, [path.join(root, 'scripts/ui-smoke.mjs')], {
  cwd: root,
  env: { ...process.env, TABFLOW_UI_FOCUS: 'docs' },
  stdio: 'inherit',
});
const manifest = JSON.parse(
  await readFile(path.join(root, 'artifacts/docs-capture-manifest.json'), 'utf8'),
);
const captures = ['workspace', 'sessions', 'sidebar', 'tags', 'projects', 'proposal', 'assistant'];
if (!captures.every((name) => manifest.captures.includes(name)))
  throw Error('Documentation capture set is incomplete.');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: chromiumPath || undefined,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1640, height: 920 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  await page.route('**/*', (route) => route.abort());
  const sources = {};
  for (const name of captures) {
    const source = path.join(root, 'artifacts', `docs-${name}.png`);
    if ((await stat(source)).mtimeMs < builtAt) throw Error(`Stale documentation capture: ${name}`);
    sources[name] = `data:image/png;base64,${(await readFile(source)).toString('base64')}`;
    // Clip actual PNG pixels, not README CSS: all exports retain transparent corners.
    const png = await page.evaluate(async (src) => {
      const image = document.createElement('img');
      image.src = src;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');
      context.beginPath();
      context.roundRect(0, 0, canvas.width, canvas.height, 16);
      context.clip();
      context.drawImage(image, 0, 0);
      return canvas.toDataURL('image/png').split(',')[1];
    }, sources[name]);
    await writeFile(path.join(output, `${name}.png`), Buffer.from(png, 'base64'));
  }
  await page.setContent(await readFile(path.join(root, 'scripts/docs/overview.html'), 'utf8'));
  await page.addStyleTag({
    content: await readFile(path.join(root, 'scripts/docs/overview.css'), 'utf8'),
  });
  await page.locator('.sidebar img').evaluate(async (image, src) => {
    image.src = src;
    await image.decode();
  }, sources.sidebar);
  await page.screenshot({
    path: path.join(output, 'overview.png'),
    omitBackground: true,
    animations: 'disabled',
  });
  console.log('Rounded PNG gallery generated from current app captures.');
} finally {
  await browser.close();
}
