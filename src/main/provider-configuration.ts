import { randomUUID } from 'node:crypto';

import {
  configuredProviderSummarySchema,
  type ConfiguredProviderSummary,
  type ProviderSetupInput,
} from '../shared/contracts';
import { createProviderProfile, type ProviderProfile } from '../shared/providers';
import type { CredentialDescriptor, CredentialVault } from './credential-vault';
import type {
  ProviderSettingsStore,
  StoredProviderSettings,
} from './provider-settings-store';

type ProviderCredentialVault = Pick<CredentialVault, 'store' | 'resolve' | 'delete'>;

function summary(settings: StoredProviderSettings): ConfiguredProviderSummary {
  return configuredProviderSummarySchema.parse({
    providerId: settings.profile.providerId,
    displayName: settings.profile.displayName,
    baseUrl: settings.profile.baseUrl,
    protocol: settings.profile.protocol,
    model: settings.profile.model,
    certification: settings.profile.certification,
    storage: settings.storage,
    credentialHint: settings.credentialHint,
  });
}

export class ProviderConfigurationService {
  readonly #vault: ProviderCredentialVault;
  readonly #store: ProviderSettingsStore;
  #active: StoredProviderSettings | null = null;

  constructor(vault: ProviderCredentialVault, store: ProviderSettingsStore) {
    this.#vault = vault;
    this.#store = store;
  }

  async initialize(): Promise<ConfiguredProviderSummary | null> {
    this.#active = await this.#store.load();
    return this.#active ? summary(this.#active) : null;
  }

  getSummary(): ConfiguredProviderSummary | null {
    return this.#active ? summary(this.#active) : null;
  }

  async save(input: ProviderSetupInput): Promise<ConfiguredProviderSummary> {
    let descriptor: CredentialDescriptor | null = null;
    try {
      descriptor = await this.#vault.store({
        kind: 'model',
        storage: input.storage,
        secret: input.apiKey,
      });
      const profile = createProviderProfile({
        id: randomUUID(),
        providerId: input.providerId,
        displayName: input.displayName,
        baseUrl: input.baseUrl,
        model: input.model,
        credentialReference: descriptor.reference,
      });
      const next = {
        schemaVersion: 1,
        profile,
        storage: descriptor.storage,
        credentialHint: descriptor.displayHint,
      } satisfies StoredProviderSettings;
      if (descriptor.storage === 'windows') await this.#store.save(next);
      else await this.#store.clear();

      const previous = this.#active;
      this.#active = next;
      if (previous) await this.#vault.delete(previous.profile.credentialReference);
      return summary(next);
    } catch (reason) {
      if (descriptor && descriptor.reference !== this.#active?.profile.credentialReference) {
        await this.#vault.delete(descriptor.reference).catch(() => undefined);
      }
      throw reason;
    }
  }

  async clear(): Promise<void> {
    const previous = this.#active;
    if (previous) await this.#vault.delete(previous.profile.credentialReference);
    await this.#store.clear();
    this.#active = null;
  }

  async resolveActive(): Promise<{ profile: ProviderProfile; apiKey: string }> {
    if (!this.#active) throw new Error('No model provider is configured.');
    return {
      profile: this.#active.profile,
      apiKey: await this.#vault.resolve(this.#active.profile.credentialReference),
    };
  }
}
