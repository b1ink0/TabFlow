import { validFavicon } from '../shared/favicon';

/** Chromium's local favicon endpoint only: never fetch the original website for an icon. */
export async function captureSuspendedFavicon(url: string): Promise<string | undefined> {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return;
  try {
    const response = await fetch(
      chrome.runtime.getURL(`_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`),
      { signal: AbortSignal.timeout(1500) },
    );
    if (!response.ok) return;
    const image = await createImageBitmap(await response.blob());
    const canvas = new OffscreenCanvas(32, 32);
    const context = canvas.getContext('2d');
    if (!context) {
      image.close();
      return;
    }
    context.globalAlpha = 0.5;
    context.drawImage(image, 0, 0, 32, 32);
    image.close();
    const bytes = new Uint8Array(
      await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer(),
    );
    const value = `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
    return validFavicon(value) ? value : undefined;
  } catch {
    return;
  }
}
