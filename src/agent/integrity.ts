import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { skillNames } from './contracts';

const runtimeManifestSchema = z.object({
  schema_version: z.literal(3),
  agent_sdk_version: z.string().min(1),
  claude_code_version: z.string().min(1),
  binary: z.object({
    file: z.literal('claude.exe'),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  sandbox_launcher: z.object({
    file: z.literal('MentalLegos.SandboxLauncher.exe'),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  credential_vault: z.object({
    file: z.literal('MentalLegos.CredentialVault.exe'),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
});

const capabilityManifestSchema = z.object({
  schema_version: z.literal(1),
  bundle_version: z.string().min(1),
  skills: z.array(z.enum(skillNames)),
  files: z.array(z.object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    bytes: z.number().int().nonnegative(),
  })),
  bundle_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

async function sha256File(filePath: string): Promise<{ sha256: string; bytes: number }> {
  const content = await readFile(filePath);
  return {
    sha256: createHash('sha256').update(content).digest('hex'),
    bytes: content.byteLength,
  };
}

export async function verifyAgentBinary(
  binaryPath: string,
  manifestPath: string,
): Promise<{ agentSdkVersion: string; claudeCodeVersion: string; sha256: string }> {
  const manifest = runtimeManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, 'utf8')),
  );
  const actual = await sha256File(binaryPath);

  if (actual.bytes !== manifest.binary.bytes || actual.sha256 !== manifest.binary.sha256) {
    throw new Error('Claude Agent SDK executable integrity verification failed.');
  }

  return {
    agentSdkVersion: manifest.agent_sdk_version,
    claudeCodeVersion: manifest.claude_code_version,
    sha256: actual.sha256,
  };
}

export async function verifySandboxLauncher(
  launcherPath: string,
  manifestPath: string,
): Promise<{ sha256: string }> {
  const manifest = runtimeManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, 'utf8')),
  );
  const actual = await sha256File(launcherPath);

  if (actual.bytes !== manifest.sandbox_launcher.bytes
    || actual.sha256 !== manifest.sandbox_launcher.sha256) {
    throw new Error('Windows AppContainer launcher integrity verification failed.');
  }
  return { sha256: actual.sha256 };
}

export async function verifyCredentialVault(
  executablePath: string,
  manifestPath: string,
): Promise<{ sha256: string }> {
  const manifest = runtimeManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, 'utf8')),
  );
  const actual = await sha256File(executablePath);

  if (actual.bytes !== manifest.credential_vault.bytes
    || actual.sha256 !== manifest.credential_vault.sha256) {
    throw new Error('Windows Credential Manager helper integrity verification failed.');
  }
  return { sha256: actual.sha256 };
}

export async function verifyCapabilityBundle(
  bundleRoot: string,
): Promise<{ bundleSha256: string; skills: typeof skillNames[number][] }> {
  const manifest = capabilityManifestSchema.parse(
    JSON.parse(await readFile(path.join(bundleRoot, 'manifest.json'), 'utf8')),
  );
  const expectedSkills = [...skillNames].sort();
  const actualSkills = (await readdir(path.join(bundleRoot, '.claude', 'skills'), {
    withFileTypes: true,
  }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  if (JSON.stringify(actualSkills) !== JSON.stringify(expectedSkills)
    || JSON.stringify([...manifest.skills].sort()) !== JSON.stringify(expectedSkills)) {
    throw new Error('Capability bundle Skill set does not match the product manifest.');
  }

  const records = [];
  for (const expected of manifest.files) {
    const absolutePath = path.resolve(bundleRoot, expected.path);
    const rootPrefix = `${path.resolve(bundleRoot)}${path.sep}`;
    if (!absolutePath.startsWith(rootPrefix)) {
      throw new Error(`Capability manifest contains an unsafe path: ${expected.path}`);
    }

    const actual = await sha256File(absolutePath);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      throw new Error(`Capability file integrity verification failed: ${expected.path}`);
    }
    records.push({ path: expected.path, sha256: actual.sha256 });
  }

  const bundleSha256 = createHash('sha256')
    .update(records.map((record) => `${record.path}\0${record.sha256}\n`).join(''))
    .digest('hex');
  if (bundleSha256 !== manifest.bundle_sha256) {
    throw new Error('Capability bundle digest does not match its manifest.');
  }

  return { bundleSha256, skills: manifest.skills };
}
