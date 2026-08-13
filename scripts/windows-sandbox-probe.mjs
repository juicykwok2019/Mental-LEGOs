import { createServer } from 'node:net';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';

if (process.platform !== 'win32') {
  console.log('Windows AppContainer probe skipped on a non-Windows host.');
  process.exit(0);
}

const root = process.cwd();
const generatedRoot = path.join(root, '.generated', 'windows-sandbox');
const launcher = path.join(generatedRoot, 'MentalLegos.SandboxLauncher.exe');
const probe = path.join(generatedRoot, 'MentalLegos.SandboxProbe.exe');
const privateRoot = path.join(root, '.private');
await mkdir(privateRoot, { recursive: true });
const temporaryRoot = await mkdtemp(path.join(privateRoot, 'appcontainer-probe-'));
const workspace = path.join(temporaryRoot, 'session');
const input = path.join(workspace, 'input');
const scratch = path.join(workspace, 'scratch');
const skill = path.join(workspace, '.claude', 'skills', 'probe');
const forbiddenRoot = path.join(temporaryRoot, 'outside-workspace');
const otherSessionRoot = path.join(temporaryRoot, 'other-session');
await Promise.all([
  mkdir(input, { recursive: true }),
  mkdir(scratch, { recursive: true }),
  mkdir(skill, { recursive: true }),
  mkdir(forbiddenRoot, { recursive: true }),
  mkdir(otherSessionRoot, { recursive: true }),
]);

const allowedRead = path.join(input, 'authorized.txt');
const allowedWrite = path.join(scratch, 'agent-output.txt');
const readonlyWrite = path.join(skill, 'SKILL.md');
const forbiddenRead = path.join(forbiddenRoot, 'private.txt');
const forbiddenWrite = path.join(forbiddenRoot, 'escape.txt');
const junction = path.join(workspace, 'junction-outside');
const junctionRead = path.join(junction, 'private.txt');
const otherSessionRead = path.join(otherSessionRoot, 'private.txt');
const repositoryRead = path.join(root, '.git', 'config');
const installWrite = path.join(root, 'resources', 'windows-sandbox', 'escape-probe.txt');
await Promise.all([
  writeFile(allowedRead, 'authorized input', 'utf8'),
  writeFile(readonlyWrite, 'read-only skill', 'utf8'),
  writeFile(forbiddenRead, 'must remain private', 'utf8'),
  writeFile(otherSessionRead, 'other session must remain private', 'utf8'),
]);
await symlink(forbiddenRoot, junction, 'junction');

const server = createServer(() => {});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Could not allocate a loopback probe port.');

const profile = `MentalLEGOs.Probe.${process.pid}.${Date.now()}`;

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: root,
      env: {
        SYSTEMROOT: process.env.SYSTEMROOT,
        WINDIR: process.env.WINDIR,
        LOCALAPPDATA: process.env.LOCALAPPDATA,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        USERPROFILE: process.env.USERPROFILE,
        MENTAL_LEGOS_PROBE_SECRET: undefined,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

try {
  const result = await run(launcher, [
    'run',
    '--profile', profile,
    '--workspace', workspace,
    '--target', probe,
    '--writable', scratch,
    '--',
    allowedRead,
    allowedWrite,
    readonlyWrite,
    forbiddenRead,
    forbiddenWrite,
    junctionRead,
    otherSessionRead,
    repositoryRead,
    installWrite,
    String(address.port),
  ]);

  const expected = new Map([
    ['is_app_container', 'true'],
    ['allowed_read', 'true'],
    ['allowed_write', 'true'],
    ['readonly_write', 'false'],
    ['forbidden_read', 'false'],
    ['forbidden_write', 'false'],
    ['junction_read', 'false'],
    ['other_session_read', 'false'],
    ['repository_read', 'false'],
    ['install_write', 'false'],
    ['loopback_connect', 'false'],
    ['contained_child', 'true'],
    ['secret_visible', 'false'],
  ]);
  const actual = new Map(result.stdout.trim().split(/\r?\n/u).map((line) => line.split('=')));
  const failures = [...expected].filter(([key, value]) => actual.get(key) !== value);
  if (result.code !== 0 || failures.length > 0) {
    throw new Error([
      `AppContainer probe exited with ${result.code}.`,
      ...failures.map(([key, value]) => `${key}: expected ${value}, received ${actual.get(key)}`),
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  if ((await readFile(allowedWrite, 'utf8')).replace(/^\uFEFF/u, '') !== 'sandbox-probe') {
    throw new Error('The allowed sandbox write did not persist in scratch.');
  }
  console.log(result.stdout.trim());
  console.log('Windows AppContainer isolation probe passed.');
} finally {
  server.close();
  await run(launcher, ['delete-profile', profile, path.dirname(probe), probe]);
  await rm(installWrite, { force: true });
  await rm(temporaryRoot, { recursive: true, force: true });
}
