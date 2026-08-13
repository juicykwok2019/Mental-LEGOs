import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createProviderProfile,
  normalizeProviderBaseUrl,
  providerRegistry,
} from '../../src/shared/providers';

describe('provider protocol registry', () => {
  it('keeps reviewed Anthropic and OpenAI provider products explicit', () => {
    expect(providerRegistry.map((provider) => provider.id)).toEqual([
      'anthropic', 'kimi-code', 'kimi-open-platform', 'deepseek', 'zhipu',
    ]);
    for (const provider of providerRegistry) {
      expect(provider.baseUrl).toMatch(/^https:\/\//u);
      expect(provider.baseUrl).not.toMatch(/chat\/completions|\/v1\/responses/u);
      expect(provider.officialSource).toMatch(/^https:\/\//u);
      expect(provider.keySourceUrl).toMatch(/^https:\/\//u);
      expect(provider.reviewedOn).toBe('2026-08-14');
    }
    expect(providerRegistry.find((provider) => provider.id === 'kimi-code')).toMatchObject({
      protocol: 'anthropic-messages',
      baseUrl: 'https://api.kimi.com/coding',
      recommendedModels: ['kimi-for-coding'],
    });
    expect(providerRegistry.find((provider) => provider.id === 'kimi-open-platform'))
      .toMatchObject({
        protocol: 'openai-chat-completions',
        baseUrl: 'https://api.moonshot.cn/v1',
      });
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

  it('binds a selected provider product to its protocol even with a custom gateway URL', () => {
    const openPlatform = createProviderProfile({
      id: randomUUID(),
      providerId: 'kimi-open-platform',
      displayName: 'Kimi Open Platform',
      baseUrl: 'https://gateway.example.test/v1',
      model: 'kimi-k3',
      credentialReference: `session:model:${randomUUID()}`,
    });
    expect(openPlatform.protocol).toBe('openai-chat-completions');
    expect(openPlatform.certification).toBe('custom-unverified');
  });

  it('rejects unsafe provider URL forms', () => {
    expect(() => normalizeProviderBaseUrl('http://api.example.test')).toThrow('HTTPS');
    expect(() => normalizeProviderBaseUrl('https://name:value@example.test')).toThrow('credentials');
    expect(() => normalizeProviderBaseUrl('https://127.0.0.1:8443')).toThrow('local');
    expect(() => normalizeProviderBaseUrl('https://192.168.1.20')).toThrow('private');
    expect(() => normalizeProviderBaseUrl('https://api.example.test/path?key=value')).toThrow('query');
  });
});
