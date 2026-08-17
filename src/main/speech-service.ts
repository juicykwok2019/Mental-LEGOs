import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AsrTranscription } from '../asr/contracts';
import {
  LocalAsrModelManager,
} from '../asr/model-manager';
import {
  loadLocalAsrModelManifest,
  type LocalAsrModelManifest,
} from '../asr/model-manifest';

// Local speech productization (WP-P1-03): recordings arrive from the renderer
// as WAV bytes, are kept in the app media directory (user-deletable), and are
// transcribed by the local SenseVoice runtime. Audio never leaves the device.

const MAX_RECORDING_BYTES = 200 * 1024 * 1024;

export interface SpeechTranscriber {
  transcribe(input: {
    modelDirectory: string;
    audioPath: string;
    language?: string;
  }): Promise<AsrTranscription>;
}

export interface SpeechReadiness {
  model: 'missing' | 'invalid' | 'ready';
  displayName: string;
  downloadBytes: number;
  detail: string | null;
}

export interface SpeechTranscriptionResult {
  recordingId: string;
  mediaPath: string;
  text: string;
  audioDurationSeconds: number;
  realTimeFactor: number;
}

function assertWavBytes(bytes: Uint8Array): void {
  if (bytes.byteLength < 44 || bytes.byteLength > MAX_RECORDING_BYTES) {
    throw new Error('Recording size is out of range.');
  }
  const riff = Buffer.from(bytes.slice(0, 4)).toString('ascii');
  const wave = Buffer.from(bytes.slice(8, 12)).toString('ascii');
  if (riff !== 'RIFF' || wave !== 'WAVE') {
    throw new Error('Recording is not a WAV file.');
  }
}

export class SpeechService {
  readonly #transcriber: SpeechTranscriber;
  readonly #manager: LocalAsrModelManager;
  readonly #manifestPath: string;
  readonly #mediaRoot: string;
  #manifest: LocalAsrModelManifest | null = null;
  #installPromise: Promise<void> | null = null;

  constructor(options: {
    transcriber: SpeechTranscriber;
    modelsRoot: string;
    manifestPath: string;
    mediaRoot: string;
  }) {
    this.#transcriber = options.transcriber;
    this.#manager = new LocalAsrModelManager({ modelsRoot: options.modelsRoot });
    this.#manifestPath = options.manifestPath;
    this.#mediaRoot = path.resolve(options.mediaRoot);
  }

  async #loadManifest(): Promise<LocalAsrModelManifest> {
    this.#manifest ??= await loadLocalAsrModelManifest(this.#manifestPath);
    return this.#manifest;
  }

  async readiness(): Promise<SpeechReadiness> {
    const manifest = await this.#loadManifest();
    const status = await this.#manager.inspect(manifest, false);
    return {
      model: status.state === 'installed' ? 'ready' : status.state,
      displayName: manifest.displayName,
      downloadBytes: manifest.archive.bytes,
      detail: status.state === 'invalid' ? (status.reason ?? null) : null,
    };
  }

  async install(): Promise<SpeechReadiness> {
    const manifest = await this.#loadManifest();
    if (!this.#installPromise) {
      this.#installPromise = (async () => {
        const status = await this.#manager.inspect(manifest, true);
        if (status.state !== 'installed') {
          await this.#manager.install(manifest);
        }
      })().finally(() => {
        this.#installPromise = null;
      });
    }
    await this.#installPromise;
    return this.readiness();
  }

  async transcribe(wavBytes: Uint8Array): Promise<SpeechTranscriptionResult> {
    assertWavBytes(wavBytes);
    const manifest = await this.#loadManifest();
    const status = await this.#manager.inspect(manifest, false);
    if (status.state !== 'installed') {
      throw new Error('先在设置中下载并校验本地语音模型，再使用语音回答。');
    }
    await mkdir(this.#mediaRoot, { recursive: true });
    const recordingId = randomUUID();
    const mediaPath = path.join(this.#mediaRoot, `recording-${recordingId}.wav`);
    await writeFile(mediaPath, wavBytes, { flag: 'wx' });
    const transcription = await this.#transcriber.transcribe({
      modelDirectory: status.modelDirectory,
      audioPath: mediaPath,
      language: 'auto',
    });
    return {
      recordingId,
      mediaPath,
      text: transcription.text,
      audioDurationSeconds: transcription.audioDurationSeconds,
      realTimeFactor: transcription.realTimeFactor,
    };
  }
}
