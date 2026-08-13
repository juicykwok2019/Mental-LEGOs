import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const repositoryRoot = process.cwd();
const stagedOnly = process.argv.includes('--staged');

const gitArgs = stagedOnly
  ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']
  : ['ls-files', '--cached', '--others', '--exclude-standard', '-z'];

const gitResult = spawnSync('git', gitArgs, {
  cwd: repositoryRoot,
  encoding: 'utf8',
});

if (gitResult.status !== 0) {
  console.error(gitResult.stderr || 'Unable to enumerate repository files.');
  process.exit(1);
}

const files = gitResult.stdout
  .split('\0')
  .filter(Boolean)
  .filter((file) => !file.startsWith('.private/'));

const sensitivePathSegments = [
  'recordings/',
  'transcripts/',
  'resumes/',
  'jd/',
  'uploads/',
  'exports/',
];

const sensitiveContentPatterns = [
  { pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u, reason: 'private key' },
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/u, reason: 'API key-like value' },
  { pattern: /\bAKLT[A-Za-z0-9]{12,}\b/u, reason: 'access key-like value' },
  { pattern: /[A-Za-z]:\\Users\\[^\\\s]+/u, reason: 'Windows user path' },
  { pattern: /\/(?:Users|home)\/[^/\s]+/u, reason: 'user home path' },
];

const violations = [];

for (const file of files) {
  const normalizedPath = file.replaceAll('\\', '/').toLowerCase();
  if (sensitivePathSegments.some((segment) => normalizedPath.includes(segment))) {
    violations.push(`${file}: private data directory`);
    continue;
  }

  let content;
  if (stagedOnly) {
    const stagedFile = spawnSync('git', ['show', `:${file}`], {
      cwd: repositoryRoot,
      encoding: null,
    });
    if (stagedFile.status !== 0) {
      violations.push(`${file}: unable to inspect staged content`);
      continue;
    }
    content = stagedFile.stdout;
  } else {
    try {
      content = await readFile(path.join(repositoryRoot, file));
    } catch {
      continue;
    }
  }

  if (content.includes(0)) {
    continue;
  }

  const text = content.toString('utf8');
  for (const { pattern, reason } of sensitiveContentPatterns) {
    if (pattern.test(text)) {
      violations.push(`${file}: ${reason}`);
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Privacy scan passed for ${files.length} file(s).`);
}
