// Suite 7 停顿统计 e2e（docs/evaluation-plan.md）：合成 WAV（已知静音位置）
// → 本地 sherpa-onnx ASR → 停顿检出误差 ≤ 0.3 秒。
//
// 固定音频 tests/fixtures/eval/pause-known.wav 由 Windows TTS 合成的三段
// 虚构中文语句拼接而成，段间插入精确时长的纯静音（见 pause-known.json）。
// 纯本地推理、零 token；需要本地模型目录，用 MENTAL_LEGOS_ASR_MODEL_DIR
// 门控（未设置时跳过），与其他 live 门控测试同风格。
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { transcribeLocalWave } from '../../src/asr/runtime';
import { computePauseStats } from '../../src/main/speech-service';

const modelDirectory = process.env.MENTAL_LEGOS_ASR_MODEL_DIR;
const asrProbe = modelDirectory ? it : it.skip;

interface PauseExpectation {
  sampleRate: number;
  totalSeconds: number;
  expectedPauses: Array<{ seconds: number }>;
  pauseThresholdSeconds: number;
  toleranceSeconds: number;
}

describe('pause detection end to end (Suite 7)', () => {
  asrProbe('detects the known silences within ±0.3s through real ASR', async () => {
    const fixturesDirectory = path.resolve(__dirname, '..', 'fixtures', 'eval');
    const expectation = JSON.parse(
      await readFile(path.join(fixturesDirectory, 'pause-known.json'), 'utf8'),
    ) as PauseExpectation;

    const transcription = await transcribeLocalWave({
      modelDirectory: modelDirectory!,
      audioPath: path.join(fixturesDirectory, 'pause-known.wav'),
      language: 'zh',
      numThreads: 2,
    });

    // ASR 必须真的识别出语音内容，否则停顿统计无从谈起。
    expect(transcription.tokens.length).toBeGreaterThan(5);
    expect(transcription.audioDurationSeconds).toBeCloseTo(expectation.totalSeconds, 1);

    const stats = computePauseStats(
      transcription.timestamps,
      transcription.durations,
      expectation.pauseThresholdSeconds,
    );
    expect(stats.pauseCount).toBe(expectation.expectedPauses.length);

    // 逐个核对检出的停顿时长与已知静音的误差。
    const detectedGaps: number[] = [];
    for (let index = 1; index < transcription.timestamps.length; index += 1) {
      const previousEnd = (transcription.timestamps[index - 1] ?? 0)
        + (transcription.durations[index - 1] ?? 0);
      const gap = (transcription.timestamps[index] ?? 0) - previousEnd;
      if (gap >= expectation.pauseThresholdSeconds) detectedGaps.push(gap);
    }
    detectedGaps.sort((left, right) => left - right);
    const expected = expectation.expectedPauses
      .map((pause) => pause.seconds)
      .sort((left, right) => left - right);
    expect(detectedGaps).toHaveLength(expected.length);
    for (const [index, seconds] of expected.entries()) {
      expect(
        Math.abs((detectedGaps[index] ?? 0) - seconds),
        `pause #${index}: detected ${(detectedGaps[index] ?? 0).toFixed(2)}s vs known ${seconds}s`,
      ).toBeLessThanOrEqual(expectation.toleranceSeconds);
    }

    // 最长停顿也要落在误差带内（这是用户在演讲复盘里看到的数字）。
    const longestExpectedMs = Math.max(...expected) * 1000;
    expect(Math.abs(stats.longestPauseMs - longestExpectedMs))
      .toBeLessThanOrEqual(expectation.toleranceSeconds * 1000);
  }, 300_000);
});
