import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import type { PageContent } from '../shared/types';
export default defineUnlistedScript(() => {
  if (globalThis.__tabloomReader) return;
  let dirty = false;
  document.addEventListener(
    'input',
    (event) => {
      const target = event.target;
      if (
        event.isTrusted &&
        target instanceof HTMLElement &&
        (target.matches('input,textarea,select,[contenteditable]') || target.isContentEditable)
      )
        dirty = true;
    },
    true,
  );
  globalThis.__tabloomReader = (limit: number): PageContent => {
    const scope = document.querySelector('main,article,[role="main"]') || document.body;
    const clone = scope?.cloneNode(true) as HTMLElement | undefined;
    clone
      ?.querySelectorAll(
        'script,style,noscript,nav,footer,header,input,textarea,select,[contenteditable],[hidden],[aria-hidden="true"]',
      )
      .forEach((n) => n.remove());
    const playing = [...document.querySelectorAll<HTMLMediaElement>('video,audio')].some(
      (m) => !m.paused && !m.ended,
    );
    const changed = [
      ...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea'),
    ].some((n) =>
      n instanceof HTMLInputElement && ['checkbox', 'radio'].includes(n.type)
        ? n.checked !== n.defaultChecked
        : n.value !== n.defaultValue,
    );
    const changedSelect = [...document.querySelectorAll<HTMLSelectElement>('select')].some(
      (select) => {
        const options = [...select.options];
        const hasDefault = options.some((option) => option.defaultSelected);
        const implicitDefault = options.findIndex(
          (option) =>
            !option.disabled &&
            !(option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled),
        );
        return options.some(
          (option, index) =>
            option.selected !==
            (hasDefault ? option.defaultSelected : !select.multiple && index === implicitDefault),
        );
      },
    );
    return {
      title: document.title,
      description:
        document
          .querySelector<HTMLMetaElement>('meta[name="description"]')
          ?.content?.slice(0, 1200) || '',
      headings: [...document.querySelectorAll('h1,h2,h3')]
        .slice(0, 25)
        .map((n) => n.textContent?.trim().slice(0, 200) || ''),
      text: (clone?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, limit),
      capturedAt: Date.now(),
      url: location.href,
      scroll: scrollY,
      dirty: dirty || changed || changedSelect,
      playing,
    };
  };
});
