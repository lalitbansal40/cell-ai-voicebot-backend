import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { CALL_LIMITS } from '../../config/limits';
import { storageKey, type StorageProvider } from '../../core/storage';
import { StereoMixer } from '../../core/voice/audio/recorder';
import { WavFileWriter } from '../../core/voice/audio/wav';
import type { CallRecording } from '../../db/models/call.model';

/** Live stereo recording of a call (customer left, bot right) written to a temp WAV. */
export class CallRecorder {
  private readonly mixer: StereoMixer;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    private readonly writer: WavFileWriter,
    readonly file: string,
    legRate: number,
  ) {
    this.mixer = new StereoMixer(legRate, CALL_LIMITS.recordingSampleRate, CALL_LIMITS.frameMs);
  }

  static async open(dir: string, callId: string, legRate: number): Promise<CallRecorder> {
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${callId}.wav`);
    const writer = await WavFileWriter.create(file, CALL_LIMITS.recordingSampleRate, 2);
    return new CallRecorder(writer, file, legRate);
  }

  customer(frame: Int16Array): void {
    if (!this.closed) this.mixer.addCustomer(frame);
  }

  bot(frame: Int16Array): void {
    if (!this.closed) this.mixer.addBot(frame);
  }

  /** 20 ms of wall-clock audio (called by the session clock). */
  tick(): void {
    if (this.closed) return;
    const block = this.mixer.tick();
    this.chain = this.chain.then(() => this.writer.write(block));
  }

  async close(): Promise<{ durationMs: number; dataBytes: number }> {
    this.closed = true;
    await this.chain;
    return this.writer.close();
  }
}

/** Uploads the finished file (3 tries) and removes the temp copy. */
export const uploadRecording = async (
  storage: StorageProvider,
  input: { accountId: string; callId: string; file: string; durationMs: number },
  attempts: number = CALL_LIMITS.recordingUploadAttempts,
): Promise<CallRecording> => {
  const key = storageKey({
    accountId: input.accountId,
    area: 'recordings',
    id: input.callId,
    ext: 'wav',
  });
  const body = await readFile(input.file);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await storage.put(key, body, { contentType: 'audio/wav' });
      await rm(input.file, { force: true });
      return {
        fileKey: key,
        durationSec: Math.round(input.durationMs / 1000),
        sizeBytes: body.length,
        format: 'wav',
      };
    } catch (err) {
      lastError = err;
    }
  }
  await rm(input.file, { force: true });
  throw lastError;
};
