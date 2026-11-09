import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validFavicon } from '../src/shared/tabs/favicon';
import { parseTagSelection } from '../src/shared/tabs/tags';
describe('persistent favicon and tag boundaries', () => {
  it('accepts only bounded 32px PNGs, never remote or executable icons', () => {
    const png = `data:image/png;base64,${readFileSync(new URL('../public/icons/32.png', import.meta.url)).toString('base64')}`;
    expect(validFavicon(png)).toBe(true);
    expect(
      validFavicon(
        `data:image/png;base64,${readFileSync(new URL('../public/icons/16.png', import.meta.url)).toString('base64')}`,
      ),
    ).toBe(false);
    expect(validFavicon('https://example.test/icon.png')).toBe(false);
    expect(validFavicon('data:image/svg+xml,<svg onload="alert(1)"></svg>')).toBe(false);
    expect(validFavicon(png + 'A'.repeat(12000))).toBe(false);
  });
  it('keeps comma-containing tags distinct and validates selection data', () => {
    expect(parseTagSelection('["PR, issue","research","research"]')).toEqual([
      'PR, issue',
      'research',
    ]);
    expect(() => parseTagSelection('[42]')).toThrow('tags');
    const merged = Array.from({ length: 26 }, (_, index) => `merged-${index}`);
    expect(parseTagSelection(JSON.stringify(merged))).toEqual(merged);
    expect(() => parseTagSelection(JSON.stringify(['x'.repeat(81)]))).toThrow('tags');
  });
});
