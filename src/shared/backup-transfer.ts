export const BACKUP_CHUNK_CHARACTERS = 512 * 1024;
export const MAX_BACKUP_CHARACTERS = 512 * 1024 * 1024;

/** Keep UTF-16 pairs together because Blob encodes each part independently. */
export function backupTextChunk(text: string, offset: number) {
  let end = Math.min(text.length, offset + BACKUP_CHUNK_CHARACTERS);
  const last = text.charCodeAt(end - 1);
  if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
  return { text: text.slice(offset, end), nextOffset: end < text.length ? end : null };
}
