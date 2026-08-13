import { access, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import type {
  AsrDiagnosticReport,
  AsrTranscription,
} from './contracts';

interface Waveform {
  samples: Float32Array;
  sampleRate: number;
}

interface OfflineStream {
  acceptWaveform(waveform: Waveform): void;
}

interface OfflineRecognitionResult {
  text?: unknown;
  lang?: unknown;
  emotion?: unknown;
  event?: unknown;
  tokens?: unknown;
  timestamps?: unknown;
  durations?: unknown;
}

interface OfflineRecognizer {
  createStream(): OfflineStream;
  decodeAsync(stream: OfflineStream): Promise<OfflineRecognitionResult>;
}

interface OfflineRecognizerConstructor {
  createAsync(config: unknown): Promise<OfflineRecognizer>;
}

interface SherpaOnnxRuntime {
  version: string;
  gitSha1: string;
  OfflineRecognizer: OfflineRecognizerConstructor;
  readWave(audioPath: string, enableExternalBuffer: boolean): Waveform;
}

const require = createRequire(import.meta.url);
let loadedRuntime: SherpaOnnxRuntime | undefined;
let cachedRecognizer:
  | { cacheKey: string; recognizer: OfflineRecognizer }
  | undefined;

function loadSherpaRuntime(): SherpaOnnxRuntime {
  if (loadedRuntime) return loadedRuntime;

  const candidate = require('sherpa-onnx-node') as Partial<SherpaOnnxRuntime>;
  if (
    candidate.version !== '1.13.4'
    || typeof candidate.gitSha1 !== 'string'
    || typeof candidate.OfflineRecognizer?.createAsync !== 'function'
    || typeof candidate.readWave !== 'function'
  ) {
    throw new Error('The pinned sherpa-onnx runtime is unavailable or incompatible.');
  }

  loadedRuntime = candidate as SherpaOnnxRuntime;
  return loadedRuntime;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
    : [];
}

async function assertReadableFile(filePath: string, label: string): Promise<void> {
  await access(filePath);
  const file = await stat(filePath);
  if (!file.isFile() || file.size === 0) {
    throw new Error(`${label} is missing or empty.`);
  }
}

async function getRecognizer(
  modelDirectory: string,
  language: string,
  numThreads: number,
): Promise<OfflineRecognizer> {
  const modelPath = path.join(modelDirectory, 'model.int8.onnx');
  const tokensPath = path.join(modelDirectory, 'tokens.txt');
  await Promise.all([
    assertReadableFile(modelPath, 'SenseVoice model'),
    assertReadableFile(tokensPath, 'SenseVoice token file'),
  ]);

  const cacheKey = JSON.stringify({ modelPath, tokensPath, language, numThreads });
  if (cachedRecognizer?.cacheKey === cacheKey) return cachedRecognizer.recognizer;

  const runtime = loadSherpaRuntime();
  const recognizer = await runtime.OfflineRecognizer.createAsync({
    featConfig: {
      sampleRate: 16_000,
      featureDim: 80,
    },
    modelConfig: {
      senseVoice: {
        model: modelPath,
        language,
        useInverseTextNormalization: 1,
      },
      tokens: tokensPath,
      numThreads,
      provider: 'cpu',
      debug: 0,
    },
  });

  cachedRecognizer = { cacheKey, recognizer };
  return recognizer;
}

export function diagnoseAsrRuntime(): AsrDiagnosticReport {
  const runtime = loadSherpaRuntime();
  return {
    runtime: 'sherpa-onnx-node',
    runtimeVersion: '1.13.4',
    runtimeGitSha1: runtime.gitSha1,
    model: 'SenseVoiceSmall int8 2024-07-17',
    offline: true,
    supportedLanguages: ['zh', 'en', 'ja', 'ko', 'yue'],
  };
}

export async function transcribeLocalWave(input: {
  modelDirectory: string;
  audioPath: string;
  language: string;
  numThreads: number;
}): Promise<AsrTranscription> {
  if (path.extname(input.audioPath).toLowerCase() !== '.wav') {
    throw new Error('Local transcription currently accepts WAV audio only.');
  }
  await assertReadableFile(input.audioPath, 'Audio file');

  const runtime = loadSherpaRuntime();
  const recognizer = await getRecognizer(
    input.modelDirectory,
    input.language,
    input.numThreads,
  );
  // Electron utility processes reject V8 external buffers. The sherpa API
  // explicitly supports regular ArrayBuffer-backed samples for this case.
  const wave = runtime.readWave(input.audioPath, false);
  if (
    !Number.isInteger(wave.sampleRate)
    || wave.sampleRate <= 0
    || !(wave.samples instanceof Float32Array)
    || wave.samples.length === 0
  ) {
    throw new Error('The WAV audio could not be decoded into a valid waveform.');
  }

  const stream = recognizer.createStream();
  stream.acceptWaveform(wave);
  const started = performance.now();
  const result = await recognizer.decodeAsync(stream);
  const elapsedMilliseconds = performance.now() - started;
  const audioDurationSeconds = wave.samples.length / wave.sampleRate;

  return {
    text: stringValue(result.text),
    language: stringValue(result.lang),
    emotion: stringValue(result.emotion),
    event: stringValue(result.event),
    tokens: stringArray(result.tokens),
    timestamps: numberArray(result.timestamps),
    durations: numberArray(result.durations),
    audioDurationSeconds,
    elapsedMilliseconds,
    realTimeFactor: elapsedMilliseconds / 1_000 / audioDurationSeconds,
  };
}
