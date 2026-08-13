import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createProviderProfile,
  normalizeProviderBaseUrl,
  providerRegistry,
} from '../../src/shared/providers';

describe('Anthropic-format provider registry', () => {
  it('contains only reviewed HTTPS Anthropic-format endpoints', () => {
    expect(providerRegistry.map((provider) => provider.id)).toEqual([
      'anthropic', 'deepseek', 'zhipu',
    ]);
    for (const provider of providerRegistry) {
      expect(provider.baseUrl).toMatch(/^https:\/\//u);
      expect(provider.baseUrl).not.toMatch(/chat\/completions|\/v1\/responses/u);
      expect(provider.officialSource).toMatch(/^https:\/\//u);
      expect(provider.reviewedOn).toBe('2026-08-13');
    }
  });

  it('preserves official certification only for the exact reviewed endpoint', () => {
    const profile = createProviderProfile({
      id: randomUUID(),
      providerId: 'deepseek',
      displayName: 'DeepSeek standard API',
      baseUrl: 'https://api.deepseek.com/anthropic/',
      model: 'deepseek-v4-pro',
      credentialReference: `session:model:${randomUUID()}`,
    });
    expect(profile.baseUrl).toBe('https://api.deepseek.com/anthropic');
    expect(profile.certification).toBe('official-compatible-pending-app-certification');

    const overridden = createProviderProfile({
      ...profile,
      id: randomUUID(),
      baseUrl: 'https://gateway.example.test/anthropic',
    });
    expect(overridden.certification).toBe('custom-unverified');
  });

  it('rejects unsafe provider URL forms', () => {
    expect(() => normalizeProviderBaseUrl('http://api.example.test')).toThrow('HTTPS');
    expect(() => normalizeProviderBaseUrl('https://name:value@example.test')).toThrow('credentials');
    expect(() => normalizeProviderBaseUrl('https://127.0.0.1:8443')).toThrow('local');
    expect(() => normalizeProviderBaseUrl('https://192.168.1.20')).toThrow('private');
    expect(() => normalizeProviderBaseUrl('https://api.example.test/path?key=value')).toThrow('query');
  });
});
