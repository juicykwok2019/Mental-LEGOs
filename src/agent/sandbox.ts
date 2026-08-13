import { spawn } from 'node:child_process';
import path from 'node:path';

import type { Options, SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';

import type { SessionWorkspace } from './workspace';

export interface WindowsSandboxConfiguration {
  launcherPath: string;
  workspace: SessionWorkspace;
}

function assertAbsolutePath(candidate: string, label: string): void {
  if (!path.isAbsolute(candidate)) {
    throw new Error(`${label} must be an absolute path.`);
  }
}

export function buildSandboxLauncherArguments(
  configuration: WindowsSandboxConfiguration,
  options: SpawnOptions,
): string[] {
  assertAbsolutePath(configuration.launcherPath, 'Sandbox launcher path');
  assertAbsolutePath(options.command, 'Claude Code executable path');
  if (path.resolve(options.cwd ?? '') !== path.resolve(configuration.workspace.root)) {
    throw new Error('Claude Code must start in the current session workspace.');
  }

  return [
    'run',
    '--profile', configuration.workspace.sandboxProfile,
    '--workspace', configuration.workspace.root,
    '--target', options.command,
    '--writable', configuration.workspace.scratch,
    '--writable', configuration.workspace.output,
    '--writable', configuration.workspace.temporary,
    '--writable', configuration.workspace.config,
    '--writable', configuration.workspace.bashIpc,
    '--',
    ...options.args,
  ];
}

export function createWindowsSandboxSpawner(
  configuration: WindowsSandboxConfiguration,
): NonNullable<Options['spawnClaudeCodeProcess']> {
  if (process.platform !== 'win32') {
    throw new Error('The P0 Agent sandbox currently supports Windows only.');
  }

  return (options: SpawnOptions): SpawnedProcess => spawn(
    configuration.launcherPath,
    buildSandboxLauncherArguments(configuration, options),
    {
      cwd: configuration.workspace.root,
      env: options.env,
      shell: false,
      signal: options.signal,
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    },
  );
}

export async function deleteWindowsSandboxProfile(options: {
  launcherPath: string;
  profileName: string;
  aclPaths?: string[];
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(options.launcherPath, [
      'delete-profile',
      options.profileName,
      ...(options.aclPaths ?? []),
    ], {
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `Sandbox profile deletion exited with ${code}.`));
    });
  });
}
