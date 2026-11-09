import { describe, it, expect } from 'vitest';
import { BackupTransfers } from '../src/core/backup-transfer';
import { BACKUP_CHUNK_CHARACTERS, backupTextChunk } from '../src/shared/backup/backup-transfer';

describe('large backup transport', () => {
  it('round-trips a backup beyond the runtime message limit with bounded Unicode-safe messages', async () => {
    const registry = new BackupTransfers();
    const value = { title: 'Fictional backup', text: 'x'.repeat(65 * 1024 * 1024) + '🌳日本語' };
    const transfer = registry.export(value);
    const parts: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const result = registry.read({ id: transfer.id, offset });
      expect(result.text.length).toBeLessThanOrEqual(BACKUP_CHUNK_CHARACTERS);
      expect(JSON.stringify(result).length).toBeLessThan(4 * 1024 * 1024);
      parts.push(result.text);
      offset = result.nextOffset;
    }
    registry.release(transfer.id);
    const text = await new Blob(parts).text();
    expect(JSON.parse(text)).toEqual(value);
    const upload = registry.beginImport({ length: text.length });
    for (let cursor = 0; cursor < text.length;) {
      const part = backupTextChunk(text, cursor);
      cursor = registry.write({ id: upload.id, offset: cursor, text: part.text }).nextOffset;
    }
    expect(registry.finishImport(upload.id)).toEqual(value);
  });
  it('does not split surrogate pairs at chunk boundaries', async () => {
    const text = 'x'.repeat(BACKUP_CHUNK_CHARACTERS - 1) + '🌳tail';
    const first = backupTextChunk(text, 0);
    expect(first.nextOffset).toBe(BACKUP_CHUNK_CHARACTERS - 1);
    const second = backupTextChunk(text, first.nextOffset!);
    expect(await new Blob([first.text, second.text]).text()).toBe(text);
  });
  it('rejects out-of-order and incomplete imports, and expires interrupted transfers', () => {
    let time = 1;
    const registry = new BackupTransfers(() => time);
    const upload = registry.beginImport({ length: 2 });
    expect(() => registry.write({ id: upload.id, offset: 1, text: '}' })).toThrow('out of order');
    expect(() => registry.finishImport(upload.id)).toThrow('incomplete');
    registry.write({ id: upload.id, offset: 0, text: '{' });
    expect(() => registry.export({})).toThrow('already running');
    time += 5 * 60_000 + 1;
    expect(() => registry.write({ id: upload.id, offset: 1, text: '}' })).toThrow('expired');
    expect(registry.export({ retained: true }).id).not.toBe(upload.id);
  });
});
