/** Offline, frame-accurate export using WebCodecs (via mediabunny) and an offline audio mix. */
import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_MEDIUM,
  QUALITY_VERY_HIGH,
  WebMOutputFormat,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
} from 'mediabunny';
import { Clip, Project, clipEnd, hasSound } from '../types';
import { RenderItem, getMedia, projectDuration, renderItems } from './edit';
import { MediaRuntime, decodeAudio, seekTo } from './media';
import { drawFrame } from './render';
import { clamp } from './util';

export interface ExportOptions {
  height: number;
  fps: number;
  format: 'mp4' | 'webm';
  quality: 'medium' | 'high' | 'very-high';
}

export interface ExportResult {
  blob: Blob;
  extension: string;
  notes: string[];
}

const QUALITIES = { medium: QUALITY_MEDIUM, high: QUALITY_HIGH, 'very-high': QUALITY_VERY_HIGH };
const SAMPLE_RATE = 48000;
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export const supportsExport = () => typeof VideoEncoder !== 'undefined' && typeof OffscreenCanvas !== 'undefined';

async function mixAudio(project: Project, runtime: Record<string, MediaRuntime>, duration: number): Promise<AudioBuffer | null> {
  const muted = new Set(project.tracks.filter((t) => t.muted).map((t) => t.id));
  const clips = project.clips.filter(
    (c) => hasSound(c) && !muted.has(c.trackId) && c.volume > 0 && getMedia(project, c.mediaId)?.hasAudio && runtime[c.mediaId!],
  );
  if (!clips.length) return null;
  const ctx = new OfflineAudioContext(2, Math.ceil(duration * SAMPLE_RATE), SAMPLE_RATE);
  const decoded = new Map<string, AudioBuffer | null>();
  let scheduled = 0;
  for (const clip of clips) {
    if (!decoded.has(clip.mediaId!)) decoded.set(clip.mediaId!, await decodeAudio(runtime[clip.mediaId!].blob));
    const buffer = decoded.get(clip.mediaId!);
    if (!buffer) continue;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = clip.speed;
    const gain = ctx.createGain();
    const end = clipEnd(clip);
    const fadeIn = Math.min(clip.fadeIn, clip.duration / 2);
    const fadeOut = Math.min(clip.fadeOut, clip.duration / 2);
    gain.gain.setValueAtTime(fadeIn > 0 ? 0 : clip.volume, clip.start);
    if (fadeIn > 0) gain.gain.linearRampToValueAtTime(clip.volume, clip.start + fadeIn);
    if (fadeOut > 0) {
      gain.gain.setValueAtTime(clip.volume, end - fadeOut);
      gain.gain.linearRampToValueAtTime(0, end);
    }
    source.connect(gain).connect(ctx.destination);
    source.start(clip.start, clip.offset, clip.duration * clip.speed);
    scheduled++;
  }
  return scheduled ? ctx.startRendering() : null;
}

/**
 * Container timestamps are often rounded (WebM stores milliseconds), so asking for
 * exactly a frame's nominal time can land a hair before it and return the previous
 * frame. Nudging the request forward makes every frame come out exactly once.
 */
export const FRAME_BIAS = 0.002;

/** Owns the decode elements used during export, independent of the live preview. */
export class FrameSources {
  private videos = new Map<string, HTMLVideoElement>();
  private images = new Map<string, ImageBitmap>();
  constructor(private project: Project, private runtime: Record<string, MediaRuntime>) {}

  async prepare(items: RenderItem[]) {
    const active = new Set(items.map((i) => i.clip.id));
    for (const [id, el] of this.videos) {
      if (active.has(id)) continue;
      el.removeAttribute('src');
      el.load();
      this.videos.delete(id);
    }
    for (const { clip, localTime } of items) {
      const rt = clip.mediaId ? this.runtime[clip.mediaId] : undefined;
      if (!rt) continue;
      if (clip.type === 'image' && !this.images.has(clip.mediaId!)) {
        this.images.set(clip.mediaId!, await createImageBitmap(rt.blob));
      } else if (clip.type === 'video') {
        let el = this.videos.get(clip.id);
        if (!el) {
          el = document.createElement('video');
          el.muted = true;
          el.preload = 'auto';
          el.playsInline = true;
          el.src = rt.url;
          await new Promise<void>((resolve, reject) => {
            el!.addEventListener('loadeddata', () => resolve(), { once: true });
            el!.addEventListener('error', () => reject(new Error('A video clip could not be decoded')), { once: true });
          });
          this.videos.set(clip.id, el);
        }
        const length = getMedia(this.project, clip.mediaId)?.duration ?? el.duration;
        await seekTo(el, clamp(clip.offset + localTime * clip.speed + FRAME_BIAS, 0, Math.max(0, length - 0.001)));
      }
    }
  }

  lookup = (clip: Clip): CanvasImageSource | null =>
    (clip.type === 'image' ? this.images.get(clip.mediaId!) : this.videos.get(clip.id)) ?? null;

  dispose() {
    for (const el of this.videos.values()) {
      el.removeAttribute('src');
      el.load();
    }
    for (const bmp of this.images.values()) bmp.close();
  }
}

export async function exportProject(
  project: Project,
  runtime: Record<string, MediaRuntime>,
  options: ExportOptions,
  onProgress: (fraction: number, stage: string) => void,
  signal: AbortSignal,
): Promise<ExportResult> {
  const duration = projectDuration(project);
  if (duration <= 0) throw new Error('Add something to the timeline before exporting');
  if (!supportsExport()) throw new Error('This browser does not support video encoding. Try a recent Chrome, Edge or Safari.');

  const notes: string[] = [];
  const height = even(options.height);
  const width = even((project.width / project.height) * options.height);

  let format: Mp4OutputFormat | WebMOutputFormat =
    options.format === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat();
  let videoCodec = await getFirstEncodableVideoCodec(format.getSupportedVideoCodecs(), { width, height });
  if (!videoCodec && options.format === 'mp4') {
    format = new WebMOutputFormat();
    videoCodec = await getFirstEncodableVideoCodec(format.getSupportedVideoCodecs(), { width, height });
    if (videoCodec) notes.push('This browser cannot encode MP4, so the video was saved as WebM instead.');
  }
  if (!videoCodec) throw new Error('No supported video encoder was found in this browser');

  onProgress(0, 'Mixing audio');
  const mix = await mixAudio(project, runtime, duration);
  const audioCodec = mix ? await getFirstEncodableAudioCodec(format.getSupportedAudioCodecs()) : null;
  if (mix && !audioCodec) notes.push('No audio encoder is available in this browser, so the export is silent.');

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  const output = new Output({ format, target: new BufferTarget() });
  const quality = QUALITIES[options.quality];
  const videoSource = new CanvasSource(canvas, { codec: videoCodec, bitrate: quality });
  output.addVideoTrack(videoSource, { frameRate: options.fps });
  const audioSource = mix && audioCodec ? new AudioBufferSource({ codec: audioCodec, bitrate: quality }) : null;
  if (audioSource) output.addAudioTrack(audioSource);

  const sources = new FrameSources(project, runtime);
  try {
    await output.start();
    if (audioSource && mix) await audioSource.add(mix);

    const frames = Math.max(1, Math.round(duration * options.fps));
    for (let i = 0; i < frames; i++) {
      if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
      const time = i / options.fps;
      await sources.prepare(renderItems(project, time));
      ctx.setTransform(width / project.width, 0, 0, height / project.height, 0, 0);
      drawFrame(ctx, project, time, sources.lookup);
      await videoSource.add(time, 1 / options.fps);
      onProgress((i + 1) / frames, 'Rendering');
    }
    onProgress(1, 'Finalizing');
    await output.finalize();
  } catch (err) {
    await output.cancel().catch(() => {});
    throw err;
  } finally {
    sources.dispose();
  }

  const isMp4 = format instanceof Mp4OutputFormat;
  return {
    blob: new Blob([output.target.buffer!], { type: isMp4 ? 'video/mp4' : 'video/webm' }),
    extension: isMp4 ? 'mp4' : 'webm',
    notes,
  };
}
