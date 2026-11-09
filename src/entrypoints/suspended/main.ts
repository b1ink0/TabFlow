import { suspendedInfo } from '../../shared/tabs/urls';
import { rpc } from '../../shared/rpc';
import { errorMessage } from '../../shared/types';
import { validFavicon } from '../../shared/tabs/favicon';
import '../../assets/suspended.css';
const info = suspendedInfo(location.href, chrome.runtime.getURL('').replace(/\/$/, ''));
const title = document.getElementById('title')!,
  status = document.getElementById('status')!,
  wake = document.getElementById('wake') as HTMLButtonElement;
if (info) {
  title.textContent = info.title;
  document.title = info.title;
  if (info.favicon)
    document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.href = info.favicon;
  document.getElementById('url')!.textContent = info.url;
  (document.getElementById('original') as HTMLAnchorElement).href = info.url;
  const favicon = new Image();
  favicon.onload = () => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.globalAlpha = 0.5;
      context.drawImage(favicon, 0, 0, 32, 32);
      const data = canvas.toDataURL('image/png');
      document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.href = data;
      void rpc('placeholderFavicon', { data }).catch(() => {});
    } catch {
      // Keep TabFlow's local icon when a browser favicon cannot be drawn.
    }
  };
  const loadBrowserIcon = () => {
    favicon.src = chrome.runtime.getURL(
      `_favicon/?pageUrl=${encodeURIComponent(info.url)}&size=32`,
    );
  };
  if (!info.favicon)
    void rpc('placeholderFavicon', undefined)
      .then((cached) => {
        if (validFavicon(cached))
          document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.href = cached;
        else loadBrowserIcon();
      })
      .catch(loadBrowserIcon);
  wake.addEventListener('click', async () => {
    wake.disabled = true;
    status.hidden = false;
    status.textContent = 'Loading original page…';
    try {
      await rpc('wakePlaceholder', undefined);
    } catch (e) {
      status.textContent = errorMessage(e);
      wake.disabled = false;
    }
  });
  void rpc('placeholder', undefined).catch(() => {});
  void rpc('placeholderPreview', undefined)
    .then((preview) => {
      if (
        !preview ||
        preview.url !== info.url ||
        !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(preview.dataUrl) ||
        preview.dataUrl.length > 350_000
      )
        return;
      const image = document.getElementById('preview') as HTMLImageElement;
      image.src = preview.dataUrl;
      image.hidden = false;
      const note = document.getElementById('preview-note')!;
      note.textContent = `Preview · ${new Date(preview.capturedAt).toLocaleString()}`;
      note.hidden = false;
    })
    .catch(() => {});
} else {
  title.textContent = 'Recovery address unavailable';
  status.textContent = 'Restore this tab from a JSON backup or snapshot.';
  status.hidden = false;
  document.getElementById('original')!.hidden = true;
  wake.disabled = true;
}
