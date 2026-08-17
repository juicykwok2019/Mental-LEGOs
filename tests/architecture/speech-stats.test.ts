import { describe, expect, it } from 'vitest';

import { computePauseStats } from '../../src/main/speech-service';

describe('pause statistics from token timestamps', () => {
  it('counts gaps beyond the threshold and tracks the longest', () => {
    // tokens at 0s(0.4s), 0.5s(0.3s), then a 2.2s gap, then a 1.3s gap
    const timestamps = [0, 0.5, 3.0, 3.4, 5.1];
    const durations = [0.4, 0.3, 0.4, 0.4, 0.3];
    const stats = computePauseStats(timestamps, durations);
    expect(stats.pauseCount).toBe(2);
    expect(stats.longestPauseMs).toBe(2200);
  });

  it('reports zero for fluent speech and empty input', () => {
    expect(computePauseStats([0, 0.4, 0.9], [0.3, 0.4, 0.3])).toEqual({
      pauseCount: 0, longestPauseMs: 0,
    });
    expect(computePauseStats([], [])).toEqual({ pauseCount: 0, longestPauseMs: 0 });
  });
});
