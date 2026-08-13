import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { CredentialStorage } from '../../src/main/credential-vault';
import { ProviderConfigurationService } from '../../src/main/provider-configuration';
import { ProviderSettingsStore } from '../../src/main/provider-settings-store';
import type { ProviderSetupInput } from '../../src/shared/contracts';

class MemoryVault {
  readonly secrets = new Map<string, string>();
  readonly deleted: string[] = [];

  async store(options: {
    kind: 'model' | 'speech';
    storage: CredentialStorage;
    secret: string;
  }) {
    const reference = `${options.storage}:${options.kind}:${randomUUID()}`;
    this.secrets.set(reference, options.secret);
    return {
      reference,
      storage: options.storage,
      displayHint: `••••${options.secret.slice(-4)}`,
    };
  }

  async resolve(reference: string): Promise<string> {
    const value = this.secrets.get(reference);
    if (!value) throw new Error('Synthetic credential is unavailable.');
    return value;
  }

  async delete(reference: string): Promise<void> {
    this.deleted.push(reference);
    this.secrets.delete(reference);
  }
}

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mental-legos-provider-'));
  temporaryDirectories.push(directory);
  return directory;
}

function input(overrides: Partial<ProviderSetupInput> = {}): ProviderSetupInput {
  return {
    providerId: 'anthropic',
    displayName: 'Synthetic Anthropic profile',
    baseUrl: 'https://api.anthropic.com',
    model: 'synthetic-model',
    storage: 'session',
    apiKey: 'synthetic-not-a-real-key-1234',
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('provider configuration boundary', () => {
  it('returns only a masked summary and keeps session keys out of settings files', async () => {
    const directory = await temporaryDirectory();
    const vault = new MemoryVault();
    const service = new ProviderConfigurationService(
      vault,
      new ProviderSettingsStore(directory),
    );
    await service.initialize();

    const configured = await service.save(input());

    expect(configured.credentialHint).toBe('••••1234');
    expect(configured).not.toHaveProperty('apiKey');
    expect(JSON.stringify(configured)).not.toContain('synthetic-not-a-real-key');
    await expect(readFile(path.join(directory, 'provider-settings.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect((await service.resolveActive()).apiKey).toBe('synthetic-not-a-real-key-1234');
  });

  it('persists only a Windows credential reference and restores its safe summary', async () => {
    const directory = await temporaryDirectory();
    const vault = new MemoryVault();
    const store = new ProviderSettingsStore(directory);
    const first = new ProviderConfigurationService(vault, store);
    await first.initialize();
    await first.save(input({ storage: 'windows' }));

    const source = await readFile(path.join(directory, 'provider-settings.json'), 'utf8');
    expect(source).toContain('windows:model:');
    expect(source).toContain('••••1234');
    expect(source).not.toContain('synthetic-not-a-real-key');

    const restored = new ProviderConfigurationService(vault, store);
    expect(await restored.initialize()).toMatchObject({
      providerId: 'anthropic',
      storage: 'windows',
      credentialHint: '••••1234',
    });
  });

  it('deletes the previous credential when the user replaces or clears a profile', async () => {
    const directory = await temporaryDirectory();
    const vault = new MemoryVault();
    const service = new ProviderConfigurationService(
      vault,
      new ProviderSettingsStore(directory),
    );
    await service.initialize();
    await service.save(input());
    const [firstReference] = vault.secrets.keys();

    await service.save(input({ providerId: 'deepseek', displayName: 'DeepSeek' }));
    expect(vault.deleted).toContain(firstReference);
    expect(vault.secrets.size).toBe(1);

    await service.clear();
    expect(vault.secrets.size).toBe(0);
    expect(service.getSummary()).toBeNull();
  });

  it('removes a newly stored credential when profile validation fails', async () => {
    const directory = await temporaryDirectory();
    const vault = new MemoryVault();
    const service = new ProviderConfigurationService(
      vault,
      new ProviderSettingsStore(directory),
    );
    await service.initialize();

    await expect(service.save(input({ baseUrl: 'http://unsafe.example.test' })))
      .rejects.toThrow('HTTPS');
    expect(vault.secrets.size).toBe(0);
    expect(vault.deleted).toHaveLength(1);
  });
});
