import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPublicationFile, publicationFiles } from './public-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (args) => execFileSync('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
const split = (buffer) => buffer.toString('utf8').split('\0').filter(Boolean);
const hasIndex = existsSync(path.join(root, '.git'));
const indexed = hasIndex ? split(git(['ls-files', '-z'])) : [];
const candidates = [
  ...new Set([
    ...indexed,
    ...(hasIndex
      ? split(git(['ls-files', '--others', '--exclude-standard', '-z']))
      : publicationFiles(root).map((file) => file.name)),
  ]),
];
const findings = [];
function report(name, version, reason, line) {
  findings.push(`${name}${line ? `:${line}` : ''} (${version}): ${reason}`);
}
const textExtensions = /\.(?:md|ts|vue|mjs|js|html|css|json|svg)$|(?:^|\/)\.gitignore$/;
const checks = [
  ['private signing key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  [
    'credential-shaped token',
    /(?:sk-(?:proj-)?[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16})/,
  ],
  [
    'personal machine path',
    /(?:[A-Z]:\\Users\\[^\\\s]+|[A-Z]:\\projects\\|\/home\/[^/\s]+\/(?:projects|Documents))/i,
  ],
  [
    'private network address',
    /https?:\/\/(?:192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)(?::\d+)?/,
  ],
  [
    'browser backup payload',
    /["']format["']\s*:\s*["']tabloom["'][\s\S]{0,300}["']exportedAt["']\s*:\s*\d+/,
  ],
];
function inspect(name, data, version) {
  if (!textExtensions.test(name)) return;
  const text = data.toString('utf8');
  for (const [reason, pattern] of checks) {
    if (reason === 'browser backup payload' && !name.endsWith('.json')) continue;
    const match = pattern.exec(text);
    if (match) report(name, version, reason, text.slice(0, match.index).split('\n').length);
  }
  if (
    /^(?:tests|scripts)\//.test(name) &&
    /https?:\/\/github\.com\/(?!fixture(?:\/|\b)|example-org(?:\/|\b))/i.test(text)
  )
    report(name, version, 'non-fictional GitHub account in a fixture or evaluation');
  if (name.endsWith('.md')) {
    if (/(?:local-docs[/\\]|CODEX_HANDOFF|TABLOOM_IMPLEMENTATION_HANDOFF)/i.test(text))
      report(name, version, 'public Markdown depends on private context');
    for (const match of text.matchAll(/(?:!?\[[^\]]*\]\(|\b(?:src|href)=["'])([^\s)"']+)/g)) {
      const target = match[1];
      if (/^(?:https?:|data:|#)/.test(target)) continue;
      const destination = path.resolve(
        root,
        path.dirname(name),
        decodeURIComponent(target.split('#')[0]),
      );
      const relative = path.relative(root, destination).split(path.sep).join('/');
      if (!isPublicationFile(relative) || !existsSync(destination))
        report(name, version, 'missing or non-public document target');
    }
  }
}
for (const name of candidates) {
  if (!isPublicationFile(name)) {
    report(
      name,
      indexed.includes(name) ? 'index' : 'worktree',
      'file is outside publication policy',
    );
    continue;
  }
  if (existsSync(path.join(root, name)))
    inspect(name, readFileSync(path.join(root, name)), 'worktree');
  if (indexed.includes(name)) inspect(name, git(['show', `:${name}`]), 'index');
}
if (findings.length) {
  console.error(`Public audit found ${findings.length} issue(s):\n${findings.join('\n')}`);
  process.exitCode = 1;
} else
  console.log(
    `Public audit passed: ${candidates.length} candidate paths; staged and working content checked.`,
  );
