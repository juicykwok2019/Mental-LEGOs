import { describe, expect, it } from 'vitest';

import { VolcanoCloudSpeechPlaceholder } from '../../src/main/speech-service';

describe('cloud speech placeholder', () => {
  it('refuses every transcription until the provider is actually integrated', async () => {
    const placeholder = new VolcanoCloudSpeechPlaceholder();
    expect(placeholder.providerLabel).toContain('火山');
    await expect(placeholder.transcribe()).rejects.toThrow(/尚未接入/u);
  });
});
