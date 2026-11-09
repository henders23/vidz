/// <reference lib="webworker" />
/** Runs Whisper speech-to-text entirely in the browser. Audio never leaves the device. */
import { AutoModel, AutoProcessor, pipeline } from '@huggingface/transformers';

export interface TranscribeRequest {
  kind: 'transcribe';
  id: number;
  model: string;
  /** Mono, 16 kHz samples. */
  audio: Float32Array;
  /** ISO code of the spoken language, e.g. "en". */
  language: string;
}

/** Ask for a voiceprint (speaker embedding) for each stretch of speech. */
export interface EmbedRequest {
  kind: 'embed';
  id: number;
  model: string;
  audio: Float32Array;
  segments: { start: number; end: number }[];
}

export type WorkerMessage =
  | { id: number; type: 'embeddings'; embeddings: Float32Array[] }
  | { id: number; type: 'progress'; stage: 'download' | 'transcribe' | 'speakers'; progress?: number }
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

const SAMPLE_RATE = 16000;
type Tensor = { data: Float32Array };
let voiceModel: Promise<{ processor: (audio: Float32Array) => Promise<unknown>; model: (inputs: unknown) => Promise<Record<string, Tensor>> }> | null = null;

async function embed({ id, model, audio, segments }: EmbedRequest) {
  voiceModel ??= (async () => ({
    processor: (await AutoProcessor.from_pretrained(model, {})) as unknown as (audio: Float32Array) => Promise<unknown>,
    model: (await AutoModel.from_pretrained(model, { dtype: 'fp32' })) as unknown as (inputs: unknown) => Promise<Record<string, Tensor>>,
  }))();
  voiceModel.catch(() => (voiceModel = null));
  const { processor, model: net } = await voiceModel;
  const embeddings: Float32Array[] = [];
  for (let i = 0; i < segments.length; i++) {
    // Very short stretches are widened a little: a voice needs about a second to be recognisable.
    const middle = (segments[i].start + segments[i].end) / 2;
    const half = Math.max(0.6, (segments[i].end - segments[i].start) / 2);
    const from = Math.max(0, Math.floor((middle - half) * SAMPLE_RATE));
    const to = Math.min(audio.length, Math.ceil((middle + half) * SAMPLE_RATE));
    const output = await net(await processor(audio.subarray(from, to)));
    const tensor = output.embeddings ?? output.last_hidden_state ?? Object.values(output)[0];
    embeddings.push(Float32Array.from(tensor.data));
    post({ id, type: 'progress', stage: 'speakers', progress: (i + 1) / segments.length });
  }
  post({ id, type: 'embeddings', embeddings });
}

self.onmessage = async (e: MessageEvent<TranscribeRequest | EmbedRequest>) => {
  if (e.data.kind === 'embed') {
    try {
      await embed(e.data);
    } catch (err) {
      post({ id: e.data.id, type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
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
