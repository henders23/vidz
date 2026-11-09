/** Speech-to-text for media items, using Whisper in a web worker. Results are cached per media item. */
import { get, set } from 'idb-keyval';
import { Word } from '../types';
import { decodeAudio } from './media';
import { getSettings } from './settings';
import { clusterSpeakers, speechSegments } from './speakers';
import type { EmbedRequest, TranscribeRequest, WorkerMessage } from './whisper.worker';

const key = (mediaId: string) => `vidz:transcript:${mediaId}`;
const SAMPLE_RATE = 16000;

export interface TranscribeProgress {
  stage: 'decode' | 'download' | 'transcribe' | 'speakers';
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

const VOICE_MODEL = 'onnx-community/wespeaker-voxceleb-resnet34-LM';

/** Send one job to the speech worker and wait for its final message. */
function request<T extends WorkerMessage['type']>(
  job: Omit<TranscribeRequest, 'id'> | Omit<EmbedRequest, 'id'>,
  done: T,
  onProgress: (p: TranscribeProgress) => void,
): Promise<Extract<WorkerMessage, { type: T }>> {
  worker ??= new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' });
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const w = worker!;
    const finish = () => {
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
    };
    const onMessage = (e: MessageEvent<WorkerMessage>) => {
      const msg = e.data;
      if (msg.id !== id) return;
      if (msg.type === 'progress') return onProgress({ stage: msg.stage, progress: msg.progress });
      finish();
      if (msg.type === done) resolve(msg as Extract<WorkerMessage, { type: T }>);
      else reject(new Error(msg.type === 'error' ? msg.message : 'Unexpected reply from the speech worker'));
    };
    const onError = (e: ErrorEvent) => {
      finish();
      worker = null;
      reject(new Error(e.message || 'The speech model could not be loaded. Check your internet connection and try again.'));
    };
    w.addEventListener('message', onMessage);
    w.addEventListener('error', onError);
    w.postMessage({ ...job, id }, [job.audio.buffer]);
  });
}

export async function transcribe(mediaId: string, blob: Blob, onProgress: (p: TranscribeProgress) => void): Promise<Word[]> {
  onProgress({ stage: 'decode' });
  const audio = await toMono16k(blob);
  const { whisperModel, language } = getSettings();
  const { words } = await request({ kind: 'transcribe', model: whisperModel, audio, language: language || 'en' }, 'done', onProgress);
  await set(key(mediaId), words);
  return words;
}

/** Work out who says what in an existing transcript. Returns the words with a speaker number on each. */
export async function labelSpeakers(mediaId: string, blob: Blob, words: Word[], onProgress: (p: TranscribeProgress) => void): Promise<Word[]> {
  onProgress({ stage: 'decode' });
  const audio = await toMono16k(blob);
  const segments = speechSegments(words);
  if (!segments.length) return words;
  const { embeddings } = await request({ kind: 'embed', model: VOICE_MODEL, audio, segments: segments.map(({ start, end }) => ({ start, end })) }, 'embeddings', onProgress);
  const speakers = clusterSpeakers(embeddings, segments.map((s) => s.end - s.start));
  const labelled = words.map((w) => ({ ...w }));
  segments.forEach((segment, i) => {
    for (let n = segment.from; n <= segment.to; n++) labelled[n].speaker = speakers[i];
  });
  await set(key(mediaId), labelled);
  return labelled;
}
