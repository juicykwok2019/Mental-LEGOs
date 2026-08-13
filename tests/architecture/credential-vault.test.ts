import { describe, expect, it } from 'vitest';

import { CredentialVault } from '../../src/main/credential-vault';

describe('credential reference boundary', () => {
  it('keeps session credentials behind opaque references', async () => {
    const vault = new CredentialVault('unused-for-session-mode');
    const value = 'synthetic-session-credential-value';
    const descriptor = await vault.store({
      kind: 'model',
      storage: 'session',
      secret: value,
    });

    expect(descriptor.reference).toMatch(/^session:model:[a-f0-9-]{36}$/u);
    expect(descriptor).not.toHaveProperty('secret');
    expect(JSON.stringify(descriptor)).not.toContain(value);
    expect(await vault.resolve(descriptor.reference)).toBe(value);

    await vault.delete(descriptor.reference);
    await expect(vault.resolve(descriptor.reference)).rejects.toThrow(
      'Session credential is unavailable.',
    );
  });

  it('clears all session-only credentials without touching the native helper', async () => {
    const vault = new CredentialVault('unused-for-session-mode');
    const descriptor = await vault.store({
      kind: 'speech',
      storage: 'session',
      secret: 'synthetic-session-speech-value',
    });

    vault.clearSessionSecrets();
    await expect(vault.resolve(descriptor.reference)).rejects.toThrow(
      'Session credential is unavailable.',
    );
  });
});
