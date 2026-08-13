import { createReadStream, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

if (process.platform !== 'win32') {
  console.log('Native Bash proxy build skipped on a non-Windows host.');
  process.exit(0);
}

const root = process.cwd();
const toolchainManifest = JSON.parse(readFileSync(
  path.join(root, 'resources', 'build-toolchains', 'windows-x64-zig.json'),
  'utf8',
));
const outputRoot = path.join(root, '.generated', 'windows-sandbox');
const cacheRoot = path.join(root, '.generated', 'zig-cache');
mkdirSync(outputRoot, { recursive: true });
mkdirSync(cacheRoot, { recursive: true });
const candidates = [
  process.env.MENTAL_LEGOS_ZIG_PATH,
  'zig.exe',
].filter(Boolean);
const compiler = candidates.map((candidate) => {
  if (candidate !== 'zig.exe') return path.resolve(candidate);
  const lookup = spawnSync('where.exe', ['zig.exe'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return lookup.status === 0 ? lookup.stdout.split(/\r?\n/u)[0] : undefined;
}).find((candidate) => {
  if (!candidate) return false;
  if (candidate === 'zig.exe') return true;
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
});
if (!compiler) throw new Error('Zig 0.16.0 is required to build the native Bash proxy.');

const compilerMetadata = statSync(compiler);
const compilerHash = createHash('sha256');
for await (const chunk of createReadStream(compiler)) compilerHash.update(chunk);
if (
  compilerMetadata.size !== toolchainManifest.binary.bytes
  || compilerHash.digest('hex') !== toolchainManifest.binary.sha256
) {
  throw new Error('The Zig compiler does not match the audited Windows x64 toolchain.');
}

const version = spawnSync(compiler, ['version'], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
});
if (version.status !== 0 || version.stdout.trim() !== toolchainManifest.version) {
  throw new Error('The native Bash proxy must be built with audited Zig 0.16.0.');
}

const result = spawnSync(compiler, [
  'build-exe',
  path.join(root, 'native', 'windows-sandbox', 'MentalLegos.BashProxy.zig'),
  '-target', 'x86_64-windows',
  '-O', 'ReleaseSmall',
  '-fstrip',
  `-femit-bin=${path.join(outputRoot, 'MentalLegos.BashProxy.exe')}`,
], {
  cwd: root,
  encoding: 'utf8',
  env: {
    ...process.env,
    ZIG_GLOBAL_CACHE_DIR: path.join(cacheRoot, 'global'),
    ZIG_LOCAL_CACHE_DIR: path.join(cacheRoot, 'local'),
  },
  windowsHide: true,
});
if (result.status !== 0) {
  throw new Error([
    'Failed to build the native Windows Bash proxy.',
    result.stdout,
    result.stderr,
  ].filter(Boolean).join('\n'));
}
console.log(`Built native Bash proxy with audited Zig ${version.stdout.trim()}.`);
