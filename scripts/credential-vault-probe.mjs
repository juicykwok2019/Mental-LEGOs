import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';

if (process.platform !== 'win32') {
  console.log('Windows Credential Manager probe skipped on a non-Windows host.');
  process.exit(0);
}

const executable = path.join(
  process.cwd(),
  '.generated',
  'windows-sandbox',
  'MentalLegos.CredentialVault.exe',
);
const target = `MentalLEGOs/model/${randomUUID()}`;
const syntheticValue = `phase-zero-credential-probe-${randomUUID()}`;

function run(command, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [command, target], {
      env: {
        SYSTEMROOT: process.env.SYSTEMROOT,
        WINDIR: process.env.WINDIR,
        LOCALAPPDATA: process.env.LOCALAPPDATA,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
      },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

try {
  const before = await run('exists');
  if (before.code !== 0 || before.stdout !== 'false') throw new Error('Probe target already exists.');
  const write = await run('write', syntheticValue);
  if (write.code !== 0 || write.stdout || write.stderr.includes(syntheticValue)) {
    throw new Error('Credential write failed or disclosed its value.');
  }
  const read = await run('read');
  if (read.code !== 0 || read.stdout !== syntheticValue || read.stderr.includes(syntheticValue)) {
    throw new Error('Credential round-trip failed or disclosed its value to stderr.');
  }
  console.log('Windows Credential Manager round-trip passed without command-line or stderr disclosure.');
} finally {
  await run('delete');
  const after = await run('exists');
  if (after.code !== 0 || after.stdout !== 'false') {
    process.exitCode = 1;
    console.error('Credential cleanup verification failed.');
  }
}
