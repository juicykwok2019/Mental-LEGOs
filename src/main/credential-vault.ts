import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export type CredentialStorage = 'session' | 'windows';

export interface CredentialDescriptor {
  reference: string;
  storage: CredentialStorage;
  displayHint: string;
}

function displayHint(secret: string): string {
  const tail = secret.slice(-4);
  return tail ? `••••${tail}` : '••••';
}

function minimalNativeEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ['SYSTEMROOT', 'WINDIR', 'LOCALAPPDATA', 'TEMP', 'TMP']) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return environment;
}

export async function runCredentialHelper(options: {
  executablePath: string;
  command: 'write' | 'read' | 'exists' | 'delete';
  target: string;
  secret?: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.executablePath, [options.command, options.target], {
      env: minimalNativeEnvironment(),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `Credential helper exited with ${code}.`));
    });
    child.stdin.end(options.secret ?? '');
  });
}

export class CredentialVault {
  readonly #executablePath: string;
  readonly #sessionSecrets = new Map<string, string>();

  constructor(executablePath: string) {
    this.#executablePath = executablePath;
  }

  async store(options: {
    kind: 'model' | 'speech';
    storage: CredentialStorage;
    secret: string;
  }): Promise<CredentialDescriptor> {
    if (!options.secret) throw new Error('Credential value cannot be empty.');
    const id = randomUUID();
    const reference = `${options.storage}:${options.kind}:${id}`;

    if (options.storage === 'session') {
      this.#sessionSecrets.set(reference, options.secret);
    } else {
      await runCredentialHelper({
        executablePath: this.#executablePath,
        command: 'write',
        target: `MentalLEGOs/${options.kind}/${id}`,
        secret: options.secret,
      });
    }
    return {
      reference,
      storage: options.storage,
      displayHint: displayHint(options.secret),
    };
  }

  async resolve(reference: string): Promise<string> {
    const match = /^(session|windows):(model|speech):([a-f0-9-]{36})$/u.exec(reference);
    if (!match) throw new Error('Invalid credential reference.');
    if (match[1] === 'session') {
      const secret = this.#sessionSecrets.get(reference);
      if (!secret) throw new Error('Session credential is unavailable.');
      return secret;
    }
    return runCredentialHelper({
      executablePath: this.#executablePath,
      command: 'read',
      target: `MentalLEGOs/${match[2]}/${match[3]}`,
    });
  }

  async delete(reference: string): Promise<void> {
    const match = /^(session|windows):(model|speech):([a-f0-9-]{36})$/u.exec(reference);
    if (!match) throw new Error('Invalid credential reference.');
    if (match[1] === 'session') {
      this.#sessionSecrets.delete(reference);
      return;
    }
    await runCredentialHelper({
      executablePath: this.#executablePath,
      command: 'delete',
      target: `MentalLEGOs/${match[2]}/${match[3]}`,
    });
  }

  clearSessionSecrets(): void {
    this.#sessionSecrets.clear();
  }
}
