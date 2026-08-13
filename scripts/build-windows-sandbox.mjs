import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

if (process.platform !== 'win32') {
  console.log('Windows sandbox helper build skipped on a non-Windows host.');
  process.exit(0);
}

const root = process.cwd();
const sourceRoot = path.join(root, 'native', 'windows-sandbox');
const outputRoot = path.join(root, '.generated', 'windows-sandbox');
const frameworkRoot = process.env.WINDIR ?? 'C:\\Windows';
const compilerCandidates = [
  path.join(frameworkRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  path.join(frameworkRoot, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
];
const compiler = compilerCandidates.find((candidate) => {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
});

if (!compiler) {
  throw new Error('The Windows .NET Framework C# compiler was not found.');
}

mkdirSync(outputRoot, { recursive: true });

for (const target of [
  ['MentalLegos.SandboxLauncher.cs', 'MentalLegos.SandboxLauncher.exe'],
  ['MentalLegos.SandboxProbe.cs', 'MentalLegos.SandboxProbe.exe'],
  ['MentalLegos.CredentialVault.cs', 'MentalLegos.CredentialVault.exe'],
  ['MentalLegos.BashProxy.cs', 'MentalLegos.BashProxy.exe'],
]) {
  const result = spawnSync(compiler, [
    '/nologo',
    '/target:exe',
    '/optimize+',
    `/out:${path.join(outputRoot, target[1])}`,
    path.join(sourceRoot, target[0]),
  ], { cwd: root, encoding: 'utf8', windowsHide: true });

  if (result.status !== 0) {
    throw new Error([
      `Failed to build ${target[1]}.`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
}

console.log(`Built Windows sandbox helpers with ${compiler}.`);
