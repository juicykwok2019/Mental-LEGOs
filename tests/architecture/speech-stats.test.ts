import { describe, expect, it } from 'vitest';

import { computePauseStats } from '../../src/main/speech-service';
import { speechStatsLine } from '../../src/main/training-session';

describe('pause statistics from token timestamps', () => {
  it('counts gaps beyond the threshold and tracks the longest', () => {
    // tokens at 0s(0.4s), 0.5s(0.3s), then a 2.2s gap, then a 1.3s gap
    const timestamps = [0, 0.5, 3.0, 3.4, 5.1];
    const durations = [0.4, 0.3, 0.4, 0.4, 0.3];
    const stats = computePauseStats(timestamps, durations);
    expect(stats.pauseCount).toBe(2);
    expect(stats.longestPauseMs).toBe(2200);
  });

  it('formats the delivery stats line the user sees after every rehearsal', () => {
    const line = speechStatsLine('字'.repeat(654), 218_000, 0, 0);
    expect(line).toContain('试讲用时 3 分 38 秒');
    expect(line).toContain('约 654 字');
    expect(line).toContain('语速 ~180 字/分');
    expect(line).toContain('没有超过 1.2 秒的明显停顿');

    const paused = speechStatsLine('字'.repeat(100), 60_000, 3, 2600);
    expect(paused).toContain('明显停顿 3 次，最长 2.6 秒');
  });

  it('reports zero for fluent speech and empty input', () => {
    expect(computePauseStats([0, 0.4, 0.9], [0.3, 0.4, 0.3])).toEqual({
      pauseCount: 0, longestPauseMs: 0,
    });
    expect(computePauseStats([], [])).toEqual({ pauseCount: 0, longestPauseMs: 0 });
  });
});
