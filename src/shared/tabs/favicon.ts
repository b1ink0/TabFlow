/** Only bounded, 32px PNGs are accepted as persistent suspended-tab icons. */
export function validFavicon(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length > 12000 ||
    !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    return false;
  try {
    const bytes = atob(value.slice(value.indexOf(',') + 1));
    return (
      bytes.slice(0, 8) === '\x89PNG\r\n\x1a\n' &&
      bytes.slice(12, 16) === 'IHDR' &&
      [16, 20].every(
        (offset) =>
          bytes.charCodeAt(offset) === 0 &&
          bytes.charCodeAt(offset + 1) === 0 &&
          bytes.charCodeAt(offset + 2) === 0 &&
          bytes.charCodeAt(offset + 3) === 32,
      )
    );
  } catch {
    return false;
  }
}
