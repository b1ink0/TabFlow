import { z } from 'zod';
import {
  BACKUP_CHUNK_CHARACTERS,
  MAX_BACKUP_CHARACTERS,
  backupTextChunk,
} from '../shared/backup-transfer';

type Transfer = { id: string; expires: number } & (
  | { kind: 'export'; text: string }
  | { kind: 'import'; parts: string[]; length: number; received: number }
);

/** One immutable transfer at a time; interrupted workers cannot commit partial imports. */
export class BackupTransfers {
  private current?: Transfer;
  constructor(private readonly time: () => number = Date.now) {}
  active() {
    if (this.current && this.current.expires <= this.time()) this.current = undefined;
    return Boolean(this.current);
  }
  private available() {
    if (this.current && this.current.expires <= this.time()) this.current = undefined;
    if (this.current)
      throw new Error('A backup transfer is already running. Finish or cancel it first.');
  }
  private require(id: string) {
    if (!this.current || this.current.id !== id || this.current.expires <= this.time()) {
      if (this.current?.expires && this.current.expires <= this.time()) this.current = undefined;
      throw new Error('Backup transfer expired or the background restarted. Retry the backup.');
    }
    this.current.expires = this.time() + 5 * 60_000;
    return this.current;
  }
  export(value: unknown) {
    this.available();
    const text = JSON.stringify(value);
    if (!text || text.length > MAX_BACKUP_CHARACTERS)
      throw new Error(
        'Backup exceeds the 512-million-character memory guard. Reduce saved history before exporting. Nothing was truncated.',
      );
    const id = crypto.randomUUID();
    this.current = { id, kind: 'export', text, expires: this.time() + 5 * 60_000 };
    return { id, length: text.length };
  }
  read(raw: unknown) {
    const { id, offset } = z.object({ id: z.string(), offset: z.number().int().min(0) }).parse(raw);
    const transfer = this.require(id);
    if (transfer.kind !== 'export' || offset >= transfer.text.length)
      throw new Error('Invalid backup export offset.');
    return backupTextChunk(transfer.text, offset);
  }
  beginImport(raw: unknown) {
    this.available();
    const { length } = z
      .object({ length: z.number().int().min(1).max(MAX_BACKUP_CHARACTERS) })
      .parse(raw);
    const id = crypto.randomUUID();
    this.current = {
      id,
      kind: 'import',
      length,
      received: 0,
      parts: [],
      expires: this.time() + 5 * 60_000,
    };
    return { id };
  }
  write(raw: unknown) {
    const { id, offset, text } = z
      .object({
        id: z.string(),
        offset: z.number().int().min(0),
        text: z.string().min(1).max(BACKUP_CHUNK_CHARACTERS),
      })
      .parse(raw);
    const transfer = this.require(id);
    if (
      transfer.kind !== 'import' ||
      offset !== transfer.received ||
      offset + text.length > transfer.length
    )
      throw new Error('Backup chunks arrived out of order or exceed their declared length.');
    transfer.parts.push(text);
    transfer.received += text.length;
    return { nextOffset: transfer.received };
  }
  finishImport(id: string): unknown {
    const transfer = this.require(id);
    if (transfer.kind !== 'import' || transfer.received !== transfer.length)
      throw new Error('Backup upload is incomplete; no data was imported.');
    const text = transfer.parts.join('');
    this.current = undefined;
    transfer.parts = [];
    return JSON.parse(text);
  }
  release(id: string) {
    if (this.current?.id === id) this.current = undefined;
  }
}
