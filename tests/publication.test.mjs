import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { isPublicationFile, publicationFiles } from '../scripts/public-files.mjs';

describe('publication boundary', () => {
  it('allows public source/docs and excludes private context, exports and signing material', () => {
    for (const name of [
      'README.md',
      '.gitattributes',
      '.husky/pre-commit',
      'AGENTS.md',
      'docs/configuration.md',
      'docs/images/overview.png',
      'src/core/engine.ts',
      'tests/model.test.ts',
    ])
      expect(isPublicationFile(name), name).toBe(true);
    for (const name of [
      'local-docs/notes.md',
      'docs/CODEX_HANDOFF.md',
      'preview/old.png',
      'artifacts/backup.json',
      'docs/export.json',
      'src/.env',
      'src/config.local.json',
      'tests/fixture.har',
      'public/private.pem',
      '.git/config',
      '.husky/_/h',
      '.husky/unrecognized-hook',
      'unknown-personal-file.json',
    ])
      expect(isPublicationFile(name), name).toBe(false);
  });
  it('collects only approved release files from a mixed working directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'tabflow-publication-'));
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep))
      throw Error('Refusing cleanup outside temporary test root.');
    try {
      for (const name of [
        'README.md',
        '.gitattributes',
        '.husky/pre-commit',
        '.husky/_/h',
        'docs/configuration.md',
        'src/example.ts',
        'local-docs/notes.md',
        'artifacts/run.json',
        'src/config.local.json',
        'personal-backup.json',
      ]) {
        const target = join(root, name);
        mkdirSync(resolve(target, '..'), { recursive: true });
        writeFileSync(target, 'fictional');
      }
      expect(
        publicationFiles(root)
          .map((file) => file.name)
          .sort(),
      ).toEqual([
        '.gitattributes',
        '.husky/pre-commit',
        'README.md',
        'docs/configuration.md',
        'src/example.ts',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
