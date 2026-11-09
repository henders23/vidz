/// <reference lib="webworker" />
/** Runs Whisper speech-to-text entirely in the browser. Audio never leaves the device. */
import { pipeline } from '@huggingface/transformers';

export interface TranscribeRequest {
  id: number;
  model: string;
  /** Mono, 16 kHz samples. */
  audio: Float32Array;
  /** ISO code of the spoken language, e.g. "en". */
  language: string;
}

export type WorkerMessage =
  | { id: number; type: 'progress'; stage: 'download' | 'transcribe'; progress?: number }
  | { id: number; type: 'done'; words: { text: string; start: number; end: number }[] }
  | { id: number; type: 'error'; message: string };

type Transcriber = (audio: Float32Array, options: Record<string, unknown>) => Promise<{ chunks?: { text: string; timestamp: [number, number | null] }[] }>;

const loaded = new Map<string, Promise<Transcriber>>();
const post = (message: WorkerMessage, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(message, transfer);

function load(model: string, id: number): Promise<Transcriber> {
  let transcriber = loaded.get(model);
  if (!transcriber) {
    const files = new Map<string, { loaded: number; total: number }>();
    transcriber = pipeline('automatic-speech-recognition', model, {
      progress_callback: (info: { status: string; file?: string; loaded?: number; total?: number }) => {
        if (info.status !== 'progress' || !info.file || !info.total) return;
        files.set(info.file, { loaded: info.loaded ?? 0, total: info.total });
        let done = 0;
        let total = 0;
        for (const f of files.values()) {
          done += f.loaded;
          total += f.total;
        }
        post({ id, type: 'progress', stage: 'download', progress: total ? done / total : 0 });
      },
    }) as unknown as Promise<Transcriber>;
    loaded.set(model, transcriber);
    transcriber.catch(() => loaded.delete(model));
  }
  return transcriber;
}

self.onmessage = async (e: MessageEvent<TranscribeRequest>) => {
  const { id, model, audio, language } = e.data;
  try {
    const transcriber = await load(model, id);
    post({ id, type: 'progress', stage: 'transcribe' });
    const output = await transcriber(audio, {
      return_timestamps: 'word',
      chunk_length_s: 30,
      stride_length_s: 5,
      language,
    });
    const words = (output.chunks ?? [])
      .map((c) => ({ text: c.text.trim(), start: c.timestamp[0], end: c.timestamp[1] ?? c.timestamp[0] + 0.3 }))
      .filter((w) => w.text && Number.isFinite(w.start));
    post({ id, type: 'done', words });
  } catch (err) {
    post({ id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
