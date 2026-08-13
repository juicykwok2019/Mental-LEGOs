import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { verifyCapabilityBundle } from './integrity';

const sessionIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u;

export interface SessionWorkspace {
  root: string;
  input: string;
  scratch: string;
  output: string;
  temporary: string;
  config: string;
  bashIpc: string;
  bashGuestRoot: string;
  bashProxy: string;
  sandboxProfile: string;
  initialBundleSha256: string;
}

function resolveWithin(root: string, child: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedChild = path.resolve(resolvedRoot, child);
  if (!resolvedChild.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Workspace path escaped its root.');
  }
  return resolvedChild;
}

export async function createSessionWorkspace(options: {
  sessionsRoot: string;
  sessionId: string;
  capabilityBundlePath: string;
}): Promise<SessionWorkspace> {
  if (!sessionIdPattern.test(options.sessionId)) {
    throw new Error('Invalid session identifier.');
  }

  const verifiedBundle = await verifyCapabilityBundle(options.capabilityBundlePath);
  const root = resolveWithin(options.sessionsRoot, options.sessionId);
  const input = resolveWithin(root, 'input');
  const scratch = resolveWithin(root, 'scratch');
  const output = resolveWithin(root, 'output');
  const temporary = resolveWithin(root, 'tmp');
  const config = resolveWithin(root, '.agent-config');
  const ipcRoot = resolveWithin(options.sessionsRoot, '.runtime-ipc');
  const bashIpc = resolveWithin(ipcRoot, options.sessionId);
  const guestRoot = resolveWithin(options.sessionsRoot, '.runtime-guests');
  const bashGuestRoot = resolveWithin(guestRoot, options.sessionId);
  const runtimeDirectory = resolveWithin(root, '.runtime');
  const bashProxy = resolveWithin(runtimeDirectory, 'bash.exe');
  const sandboxProfile = `MentalLEGOs.Agent.${createHash('sha256')
    .update(options.sessionId, 'utf8')
    .digest('hex')
    .slice(0, 32)}`;

  await mkdir(root, { recursive: true });
  await Promise.all([
    mkdir(input, { recursive: true }),
    mkdir(scratch, { recursive: true }),
    mkdir(output, { recursive: true }),
    mkdir(temporary, { recursive: true }),
    mkdir(config, { recursive: true }),
    mkdir(bashIpc, { recursive: true }),
    mkdir(bashGuestRoot, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
  ]);

  await cp(
    path.join(options.capabilityBundlePath, '.claude'),
    path.join(root, '.claude'),
    { recursive: true, force: false, errorOnExist: true },
  );
  await Promise.all([
    cp(
      path.join(options.capabilityBundlePath, 'CLAUDE.md'),
      path.join(root, 'CLAUDE.md'),
      { force: false, errorOnExist: true },
    ),
    cp(
      path.join(options.capabilityBundlePath, 'manifest.json'),
      path.join(root, 'manifest.json'),
      { force: false, errorOnExist: true },
    ),
  ]);

  await writeFile(
    path.join(root, '.workspace-policy.json'),
    `${JSON.stringify({
      schema_version: 1,
      session_id: options.sessionId,
      capability_bundle_sha256: verifiedBundle.bundleSha256,
      sandbox_profile: sandboxProfile,
      writable_directories: ['scratch', 'output', 'tmp'],
    }, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' },
  );
  await writeFile(
    path.join(bashGuestRoot, '.guest-policy.json'),
    `${JSON.stringify({
      schema_version: 1,
      session_id: options.sessionId,
      workspace_root_sha256: createHash('sha256').update(root, 'utf8').digest('hex'),
    }, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' },
  );
  await writeFile(
    path.join(bashIpc, '.ipc-policy.json'),
    `${JSON.stringify({
      schema_version: 1,
      session_id: options.sessionId,
      workspace_root_sha256: createHash('sha256').update(root, 'utf8').digest('hex'),
    }, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' },
  );

  return {
    root,
    input,
    scratch,
    output,
    temporary,
    config,
    bashIpc,
    bashGuestRoot,
    bashProxy,
    sandboxProfile,
    initialBundleSha256: verifiedBundle.bundleSha256,
  };
}

export async function stageSessionBashProxy(options: {
  workspace: SessionWorkspace;
  verifiedProxyPath: string;
}): Promise<string> {
  try {
    await copyFile(
      path.resolve(options.verifiedProxyPath),
      options.workspace.bashProxy,
      constants.COPYFILE_EXCL,
    );
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code !== 'EEXIST') throw reason;
  }
  return options.workspace.bashProxy;
}

export async function verifySessionCapabilityIntegrity(
  workspace: SessionWorkspace,
): Promise<void> {
  const result = await verifyCapabilityBundle(workspace.root);
  if (result.bundleSha256 !== workspace.initialBundleSha256) {
    throw new Error('Session capability bundle was modified during execution.');
  }
}

export async function copyAuthorizedInput(options: {
  workspace: SessionWorkspace;
  logicalName: string;
  content: string;
}): Promise<string> {
  const safeName = options.logicalName.replace(/[^a-zA-Z0-9._-]/gu, '_');
  if (!safeName || safeName === '.' || safeName === '..') {
    throw new Error('Invalid authorized input name.');
  }
  const destination = resolveWithin(options.workspace.input, safeName);
  await writeFile(destination, options.content, { encoding: 'utf8', flag: 'wx' });
  return destination;
}

export async function purgeSessionWorkspace(
  sessionsRoot: string,
  sessionId: string,
): Promise<void> {
  if (!sessionIdPattern.test(sessionId)) {
    throw new Error('Invalid session identifier.');
  }
  const root = resolveWithin(sessionsRoot, sessionId);
  const bashIpc = resolveWithin(
    resolveWithin(sessionsRoot, '.runtime-ipc'),
    sessionId,
  );
  const bashGuestRoot = resolveWithin(
    resolveWithin(sessionsRoot, '.runtime-guests'),
    sessionId,
  );
  const marker = JSON.parse(
    await readFile(path.join(root, '.workspace-policy.json'), 'utf8'),
  ) as { session_id?: unknown };
  if (marker.session_id !== sessionId) {
    throw new Error('Refusing to purge a directory without its matching session marker.');
  }
  const ipcMarker = JSON.parse(
    await readFile(path.join(bashIpc, '.ipc-policy.json'), 'utf8'),
  ) as { session_id?: unknown; workspace_root_sha256?: unknown };
  const expectedWorkspaceHash = createHash('sha256').update(root, 'utf8').digest('hex');
  if (
    ipcMarker.session_id !== sessionId
    || ipcMarker.workspace_root_sha256 !== expectedWorkspaceHash
  ) {
    throw new Error('Refusing to purge an IPC directory without its matching marker.');
  }
  const guestMarker = JSON.parse(
    await readFile(path.join(bashGuestRoot, '.guest-policy.json'), 'utf8'),
  ) as { session_id?: unknown; workspace_root_sha256?: unknown };
  if (
    guestMarker.session_id !== sessionId
    || guestMarker.workspace_root_sha256 !== expectedWorkspaceHash
  ) {
    throw new Error('Refusing to purge a Bash guest directory without its matching marker.');
  }
  await rm(root, { recursive: true, force: false });
  await rm(bashIpc, { recursive: true, force: false });
  await rm(bashGuestRoot, { recursive: true, force: false });
}
