import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const executablePath = path.join(
  repositoryRoot,
  'out',
  'Mental LEGOs-win32-x64',
  'Mental LEGOs.exe',
);
const mainBundlePath = path.join(repositoryRoot, '.vite', 'build', 'main.js');
const extraArguments = process.argv.slice(2);
const timeoutMs = extraArguments.includes('--agent-e2e-smoke') ? 330_000 : 30_000;

await Promise.all([access(executablePath), access(mainBundlePath)]);

const mainBundle = await readFile(mainBundlePath, 'utf8');
if (mainBundle.includes('createRequire)({}.url)') || mainBundle.includes('createRequire)({}.url')) {
  throw new Error(
    'Packaged main bundle contains an invalid createRequire(import.meta.url) transform.',
  );
}

await new Promise((resolve, reject) => {
  const child = spawn(executablePath, [
    '--disable-error-dialogs',
    '--smoke-test',
    ...extraArguments,
  ], {
    cwd: path.dirname(executablePath),
    env: {
      SYSTEMROOT: process.env.SYSTEMROOT,
      WINDIR: process.env.WINDIR,
      COMSPEC: process.env.COMSPEC,
      PATH: process.env.PATH,
      PATHEXT: process.env.PATHEXT,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      ELECTRON_ENABLE_LOGGING: '1',
    },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout = `${stdout}${chunk}`.slice(-16_384);
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
  });
  const timeout = setTimeout(() => {
    child.kill('SIGKILL');
    reject(new Error([
      `Packaged application did not exit within ${timeoutMs} ms.`,
      stdout,
      stderr,
    ].filter(Boolean).join('\n')));
  }, timeoutMs);

  child.once('error', (reason) => {
    clearTimeout(timeout);
    reject(reason);
  });
  child.once('exit', (code, signal) => {
    clearTimeout(timeout);
    if (code === 0) {
      resolve(undefined);
      return;
    }
    reject(new Error([
      `Packaged application exited with code ${code ?? 'null'} and signal ${signal ?? 'none'}.`,
      stdout,
      stderr,
    ].filter(Boolean).join('\n')));
  });
});

process.stdout.write('Packaged application smoke test passed.\n');
