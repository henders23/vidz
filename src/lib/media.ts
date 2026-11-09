/** Media import: probing, filmstrip thumbnails, waveform peaks, IndexedDB persistence. */
import { del, get, set } from 'idb-keyval';
import { MediaAsset, MediaKind } from '../types';
import { uid } from './util';

export const PEAKS_PER_SECOND = 50;
const THUMB_HEIGHT = 72;
const MAX_THUMBS = 40;
const MAX_DECODE_BYTES = 400 * 1024 * 1024;

export interface Filmstrip {
  url: string;
  count: number;
  width: number;
  height: number;
}

/** Non-serializable, per-session data for a media asset. */
export interface MediaRuntime {
  url: string;
  blob: Blob;
  poster?: string;
  filmstrip?: Filmstrip;
  peaks?: Float32Array;
}

interface StoredExtras {
  poster?: Blob;
  filmstrip?: { blob: Blob; count: number; width: number; height: number };
  peaks?: Float32Array;
}

const blobKey = (id: string) => `vidz:blob:${id}`;
const extrasKey = (id: string) => `vidz:extras:${id}`;

export function kindOf(file: { type: string; name: string }): MediaKind | null {
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('image/')) return 'image';
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (['mp4', 'mov', 'webm', 'mkv', 'm4v', 'avi'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus'].includes(ext)) return 'audio';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'].includes(ext)) return 'image';
  return null;
}

const once = (el: EventTarget, ok: string, timeoutMs = 15000) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${ok}`)), timeoutMs);
    const finish = (err?: Error) => {
      clearTimeout(timer);
      el.removeEventListener(ok, onOk);
      el.removeEventListener('error', onErr);
      err ? reject(err) : resolve();
    };
    const onOk = () => finish();
    const onErr = () => finish(new Error('This file could not be decoded by your browser'));
    el.addEventListener(ok, onOk);
    el.addEventListener('error', onErr);
  });

export async function seekTo(el: HTMLMediaElement, time: number) {
  if (Math.abs(el.currentTime - time) < 1e-4 && el.readyState >= 2) return;
  el.currentTime = time;
  await once(el, 'seeked');
}

async function loadMediaElement<T extends HTMLMediaElement>(el: T, url: string): Promise<T> {
  el.preload = 'auto';
  el.muted = true;
  (el as unknown as HTMLVideoElement).playsInline = true;
  el.src = url;
  await once(el, 'loadedmetadata');
  if (!isFinite(el.duration)) {
    // Recordings from MediaRecorder have no duration header; seeking far forces the browser to compute it.
    el.currentTime = 1e101;
    await once(el, 'timeupdate').catch(() => {});
    el.currentTime = 0;
  }
  return el;
}

async function makeFilmstrip(video: HTMLVideoElement): Promise<{ poster?: Blob; filmstrip?: StoredExtras['filmstrip'] }> {
  if (!video.videoWidth) return {};
  const duration = isFinite(video.duration) ? video.duration : 0;
  const count = Math.max(1, Math.min(MAX_THUMBS, Math.ceil(duration / 2)));
  const height = THUMB_HEIGHT;
  const width = Math.round((video.videoWidth / video.videoHeight) * height);
  const sheet = new OffscreenCanvas(width * count, height);
  const ctx = sheet.getContext('2d')!;
  let poster: Blob | undefined;
  for (let i = 0; i < count; i++) {
    const t = Math.min(duration - 0.05, (i + 0.5) * (duration / count));
    try {
      await seekTo(video, Math.max(0, t));
    } catch {
      break;
    }
    ctx.drawImage(video, i * width, 0, width, height);
    if (i === 0) {
      const single = new OffscreenCanvas(width * 2, height * 2);
      single.getContext('2d')!.drawImage(video, 0, 0, width * 2, height * 2);
      poster = await single.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    }
  }
  const blob = await sheet.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
  return { poster, filmstrip: { blob, count, width, height } };
}

let sharedAudioContext: AudioContext | null = null;
export const audioContext = () => (sharedAudioContext ??= new AudioContext());

export async function decodeAudio(blob: Blob): Promise<AudioBuffer | null> {
  if (blob.size > MAX_DECODE_BYTES) return null;
  try {
    return await audioContext().decodeAudioData(await blob.arrayBuffer());
  } catch {
    return null; // no audio stream, or unsupported codec
  }
}

function computePeaks(buffer: AudioBuffer): Float32Array {
  const step = Math.floor(buffer.sampleRate / PEAKS_PER_SECOND);
  const n = Math.ceil(buffer.length / step);
  const peaks = new Float32Array(n);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < n; i++) {
      let max = 0;
      const end = Math.min(data.length, (i + 1) * step);
      for (let j = i * step; j < end; j += 8) {
        const v = Math.abs(data[j]);
        if (v > max) max = v;
      }
      if (max > peaks[i]) peaks[i] = max;
    }
  }
  return peaks;
}

function toRuntime(blob: Blob, extras: StoredExtras): MediaRuntime {
  return {
    url: URL.createObjectURL(blob),
    blob,
    poster: extras.poster && URL.createObjectURL(extras.poster),
    filmstrip: extras.filmstrip && {
      url: URL.createObjectURL(extras.filmstrip.blob),
      count: extras.filmstrip.count,
      width: extras.filmstrip.width,
      height: extras.filmstrip.height,
    },
    peaks: extras.peaks,
  };
}

export async function importFile(file: File | Blob, name?: string): Promise<{ asset: MediaAsset; runtime: MediaRuntime }> {
  const fileName = name ?? (file as File).name ?? 'Untitled';
  const kind = kindOf({ type: file.type, name: fileName });
  if (!kind) throw new Error(`"${fileName}" isn't a video, audio or image file`);
  const url = URL.createObjectURL(file);
  const asset: MediaAsset = {
    id: uid(),
    name: fileName,
    kind,
    mime: file.type,
    size: file.size,
    duration: 0,
    width: 0,
    height: 0,
    hasAudio: false,
  };
  const extras: StoredExtras = {};
  try {
    if (kind === 'image') {
      const bitmap = await createImageBitmap(file).catch(() => {
        throw new Error(`"${fileName}" could not be decoded by your browser`);
      });
      asset.width = bitmap.width;
      asset.height = bitmap.height;
      bitmap.close();
    } else {
      const el = await loadMediaElement(document.createElement(kind === 'video' ? 'video' : 'audio'), url);
      asset.duration = isFinite(el.duration) ? el.duration : 0;
      if (kind === 'video') {
        const video = el as HTMLVideoElement;
        asset.width = video.videoWidth;
        asset.height = video.videoHeight;
        Object.assign(extras, await makeFilmstrip(video));
      }
      el.removeAttribute('src');
      el.load();
      const audio = await decodeAudio(file);
      if (audio) {
        asset.hasAudio = true;
        extras.peaks = computePeaks(audio);
        if (!asset.duration) asset.duration = audio.duration;
      } else {
        // Too large to analyse up-front: assume audio is present so it still plays and exports.
        asset.hasAudio = kind === 'audio' || file.size > MAX_DECODE_BYTES;
      }
    }
  } finally {
    URL.revokeObjectURL(url);
  }
  await set(blobKey(asset.id), file);
  await set(extrasKey(asset.id), extras);
  return { asset, runtime: toRuntime(file, extras) };
}

export async function loadMediaRuntime(id: string): Promise<MediaRuntime | null> {
  const blob = await get<Blob>(blobKey(id));
  if (!blob) return null;
  return toRuntime(blob, (await get<StoredExtras>(extrasKey(id))) ?? {});
}

export async function deleteMediaData(id: string) {
  await del(blobKey(id));
  await del(extrasKey(id));
}
