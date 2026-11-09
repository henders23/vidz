/** Speech-to-text for media items, using Whisper in a web worker. Results are cached per media item. */
import { get, set } from 'idb-keyval';
import { Word } from '../types';
import { decodeAudio } from './media';
import { getSettings } from './settings';
import type { TranscribeRequest, WorkerMessage } from './whisper.worker';

const key = (mediaId: string) => `vidz:transcript:${mediaId}`;
const SAMPLE_RATE = 16000;

export interface TranscribeProgress {
  stage: 'decode' | 'download' | 'transcribe';
  progress?: number;
}

export const loadTranscript = (mediaId: string) => get<Word[]>(key(mediaId));

let worker: Worker | null = null;
let nextId = 1;

/** Decode any media blob to the mono 16 kHz samples Whisper expects. */
async function toMono16k(blob: Blob): Promise<Float32Array> {
  const buffer = await decodeAudio(blob);
  if (!buffer) throw new Error('This file has no audio that can be transcribed (or it is too large to analyse)');
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(buffer.duration * SAMPLE_RATE)), SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  return (await offline.startRendering()).getChannelData(0);
}

export async function transcribe(mediaId: string, blob: Blob, onProgress: (p: TranscribeProgress) => void): Promise<Word[]> {
  onProgress({ stage: 'decode' });
  const audio = await toMono16k(blob);
  worker ??= new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' });
  const id = nextId++;
  const { whisperModel, language } = getSettings();
  const words = await new Promise<Word[]>((resolve, reject) => {
    const w = worker!;
    const onMessage = (e: MessageEvent<WorkerMessage>) => {
      const msg = e.data;
      if (msg.id !== id) return;
      if (msg.type === 'progress') return onProgress({ stage: msg.stage, progress: msg.progress });
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
      if (msg.type === 'done') resolve(msg.words);
      else reject(new Error(msg.message));
    };
    const onError = (e: ErrorEvent) => {
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
      worker = null;
      reject(new Error(e.message || 'The speech recognition model could not be loaded. Check your internet connection and try again.'));
    };
    w.addEventListener('message', onMessage);
    w.addEventListener('error', onError);
    const request: TranscribeRequest = { id, model: whisperModel, audio, language: language || 'en' };
    w.postMessage(request, [audio.buffer]);
  });
  await set(key(mediaId), words);
  return words;
}
