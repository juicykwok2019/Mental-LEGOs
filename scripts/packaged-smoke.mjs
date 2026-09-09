import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

// 自己的用户数据目录：一来不碰使用者的真实档案（设置、积木库、凭据都在
// 那里），二来单实例锁是按 userData 划分的——不隔离的话，只要本机开着这个
// 应用，冒烟启动的实例就抢不到锁、直接退出，看起来像启动失败。
const userDataDirectory = await mkdtemp(path.join(tmpdir(), 'mental-legos-smoke-'));

await new Promise((resolve, reject) => {
  const child = spawn(executablePath, [
    '--disable-error-dialogs',
    '--smoke-test',
    `--user-data-dir=${userDataDirectory}`,
    // Squirrel 装完后就是用这个参数启动应用的。当成生命周期事件处理会让应用
    // 装完即退，所以正常启动路径必须带着它跑一遍。
    '--squirrel-firstrun',
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
    // 退出码 0 只说明进程没崩。应用在 ready 之前自己 quit 掉时退出码也是 0，
    // 所以还要看主进程有没有真的走到就绪。
    if (code === 0 && stdout.includes('packaged-smoke-ready')) {
      resolve(undefined);
      return;
    }
    if (code === 0) {
      reject(new Error([
        'Packaged application exited cleanly without reaching readiness '
        + '(no packaged-smoke-ready marker) — it quit before the renderer, '
        + 'agent and ASR runtimes came up.',
        stdout,
        stderr,
      ].filter(Boolean).join('\n')));
      return;
    }
    reject(new Error([
      `Packaged application exited with code ${code ?? 'null'} and signal ${signal ?? 'none'}.`,
      stdout,
      stderr,
    ].filter(Boolean).join('\n')));
  });
}).finally(async () => {
  await rm(userDataDirectory, { recursive: true, force: true }).catch(() => {
    // 临时目录清不掉不该让冒烟失败——它在系统临时区，下次开机会被回收。
  });
});

process.stdout.write('Packaged application smoke test passed.\n');
