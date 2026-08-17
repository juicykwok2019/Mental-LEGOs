// In-app voice recorder: captures microphone audio, downsamples to 16 kHz
// mono, and encodes 16-bit PCM WAV entirely in the renderer. The bytes go to
// the main process only for local transcription; audio never leaves the device.

const TARGET_SAMPLE_RATE = 16_000;

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(44 + index * 2, Math.round(clamped * 32_767), true);
  }
  return buffer;
}

function downsample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const length = Math.floor(samples.length / ratio);
  const result = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(Math.floor((index + 1) * ratio), samples.length);
    let sum = 0;
    for (let cursor = start; cursor < end; cursor += 1) sum += samples[cursor] ?? 0;
    result[index] = end > start ? sum / (end - start) : 0;
  }
  return result;
}

export interface FinishedRecording {
  wav: ArrayBuffer;
  durationMs: number;
}

// Decode an imported audio file (mp3/m4a/wav/ogg… whatever Chromium decodes)
// to 16 kHz mono WAV entirely in the renderer, so imported recordings ride the
// same local transcription path as microphone audio and never leave the device.
export async function decodeAudioFileToWav(fileBytes: ArrayBuffer): Promise<FinishedRecording> {
  const probe = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await probe.decodeAudioData(fileBytes.slice(0));
  } catch (reason) {
    throw new Error('无法解码这个音频文件。支持常见格式（wav / mp3 / m4a / ogg）。', { cause: reason });
  } finally {
    await probe.close();
  }
  const mono = new Float32Array(decoded.length);
  for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
    const data = decoded.getChannelData(channel);
    for (let index = 0; index < data.length; index += 1) {
      mono[index] = (mono[index] ?? 0) + (data[index] ?? 0) / decoded.numberOfChannels;
    }
  }
  const resampled = downsample(mono, decoded.sampleRate, TARGET_SAMPLE_RATE);
  return {
    wav: encodeWav(resampled, TARGET_SAMPLE_RATE),
    durationMs: Math.round(decoded.duration * 1000),
  };
}

export class VoiceRecorder {
  #context: AudioContext | null = null;
  #stream: MediaStream | null = null;
  #processor: ScriptProcessorNode | null = null;
  #source: MediaStreamAudioSourceNode | null = null;
  #chunks: Float32Array[] = [];
  #startedAt = 0;

  get recording(): boolean {
    return this.#context !== null;
  }

  async start(): Promise<void> {
    if (this.#context) throw new Error('已经在录音中。');
    this.#stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    this.#context = new AudioContext();
    this.#source = this.#context.createMediaStreamSource(this.#stream);
    this.#processor = this.#context.createScriptProcessor(4096, 1, 1);
    this.#chunks = [];
    this.#startedAt = performance.now();
    this.#processor.onaudioprocess = (event) => {
      this.#chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    this.#source.connect(this.#processor);
    this.#processor.connect(this.#context.destination);
  }

  async stop(): Promise<FinishedRecording> {
    const context = this.#context;
    if (!context) throw new Error('当前没有进行中的录音。');
    const durationMs = Math.round(performance.now() - this.#startedAt);
    const sampleRate = context.sampleRate;
    this.#processor?.disconnect();
    this.#source?.disconnect();
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    await context.close();
    const total = this.#chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Float32Array(total);
    let offset = 0;
    for (const chunk of this.#chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.#context = null;
    this.#stream = null;
    this.#processor = null;
    this.#source = null;
    this.#chunks = [];
    const resampled = downsample(merged, sampleRate, TARGET_SAMPLE_RATE);
    return { wav: encodeWav(resampled, TARGET_SAMPLE_RATE), durationMs };
  }

  async cancel(): Promise<void> {
    if (!this.#context) return;
    await this.stop();
  }
}
