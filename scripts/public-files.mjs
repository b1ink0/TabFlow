import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const rootFiles = new Set([
  '.gitignore',
  '.env.example',
  '.gitattributes',
  '.prettierignore',
  '.prettierrc.json',
  'AGENTS.md',
  'README.md',
  'LICENSE',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'bun.lock',
  'package.json',
  'eslint.config.mjs',
  'tsconfig.json',
  'vitest.config.ts',
  'wxt.config.ts',
]);
const sourceRoots = new Set(['src', 'public', 'tests', 'scripts', 'docs', '.husky']);
const privateSegments = new Set([
  'local-docs',
  'artifacts',
  'preview',
  'browser-profile',
  'node_modules',
  '.git',
  '.wxt',
  '.output',
  'test-results',
  'playwright-report',
  '.agents',
  '.codex',
  '.claude',
  '.ai',
  '.tools',
]);

export function isPublicationFile(name) {
  if (name === '.env.example') return true;
  const parts = name.split('/');
  if (parts.some((part) => privateSegments.has(part) || part.startsWith('.env'))) return false;
  if (parts.length === 1) return rootFiles.has(name);
  if (parts[0] === '.husky') return name === '.husky/pre-commit';
  if (!sourceRoots.has(parts[0])) return false;
  if (
    /\.(?:har|log|pem|key|pfx|p12|zip|dump|db|sqlite)$/i.test(name) ||
    /\.local\.json$/i.test(name)
  )
    return false;
  if (parts[0] === 'docs')
    return (
      /^docs\/[a-z0-9-]+\.md$/.test(name) ||
      /^docs\/images\/[a-z0-9-]+\.(?:png|svg|webp|jpe?g)$/.test(name)
    );
  return /\.(?:ts|vue|mjs|js|html|css|json|md|svg|png|webp|woff2)$/.test(name);
}

export function publicationFiles(root) {
  const found = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      const name = relative(root, path).split(sep).join('/');
      if (entry.isDirectory()) {
        if (!privateSegments.has(entry.name) && sourceRoots.has(name.split('/')[0])) visit(path);
      } else if (entry.isFile() && isPublicationFile(name)) found.push({ path, name });
    }
  }
  if (!statSync(root).isDirectory()) throw Error('Publication root is not a directory.');
  visit(root);
  return found;
}
