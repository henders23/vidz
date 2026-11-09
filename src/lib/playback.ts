/**
 * Live preview engine. The store's playhead is the master clock; media elements
 * are slaved to it (and re-seeked if they drift) and composited onto the canvas.
 */
import { Clip, clipEnd, hasSound } from '../types';
import { useStore } from '../store';
import { fadeFactor, getMedia, projectDuration } from './edit';
import { drawFrame } from './render';
import { clamp } from './util';

const PREROLL = 1.5;
const DRIFT_TOLERANCE = 0.3;

class PreviewEngine {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private elements = new Map<string, { el: HTMLMediaElement; mediaId: string }>();
  private images = new Map<string, HTMLImageElement>();
  private dirty = true;
  private lastTick = 0;
  private raf = 0;

  attach(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dirty = true;
    if (!this.raf) {
      useStore.subscribe(() => (this.dirty = true));
      document.addEventListener('visibilitychange', () => {
        if (document.hidden && useStore.getState().playing) useStore.setState({ playing: false });
      });
      this.raf = requestAnimationFrame(this.tick);
    }
  }

  invalidate = () => {
    this.dirty = true;
  };

  private tick = (now: number) => {
    const state = useStore.getState();
    if (state.playing) {
      const dt = Math.min(0.25, (now - this.lastTick) / 1000);
      const duration = projectDuration(state.project);
      const t = state.playhead + dt;
      if (t >= duration) useStore.setState({ playhead: duration, playing: false });
      else useStore.setState({ playhead: t });
    }
    this.lastTick = now;
    this.sync();
    if (this.dirty) {
      this.dirty = false;
      this.draw();
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private element(clip: Clip, url: string): HTMLMediaElement {
    const existing = this.elements.get(clip.id);
    if (existing && existing.mediaId === clip.mediaId) return existing.el;
    if (existing) this.dispose(clip.id);
    const el = document.createElement(clip.type === 'video' ? 'video' : 'audio');
    el.preload = 'auto';
    el.src = url;
    (el as HTMLVideoElement).playsInline = true;
    (el as HTMLMediaElement & { preservesPitch: boolean }).preservesPitch = false;
    for (const ev of ['seeked', 'loadeddata', 'canplay']) el.addEventListener(ev, this.invalidate);
    this.elements.set(clip.id, { el, mediaId: clip.mediaId! });
    return el;
  }

  private dispose(clipId: string) {
    const entry = this.elements.get(clipId);
    if (!entry) return;
    entry.el.pause();
    entry.el.removeAttribute('src');
    entry.el.load();
    this.elements.delete(clipId);
  }

  private sync() {
    const { project, runtime, playhead: t, playing } = useStore.getState();
    const tracks = new Map(project.tracks.map((tr) => [tr.id, tr]));
    const seen = new Set<string>();
    for (const clip of project.clips) {
      if (!hasSound(clip) || !clip.mediaId) continue;
      const rt = runtime[clip.mediaId];
      const near = t >= clip.start - PREROLL && t < clipEnd(clip);
      if (!rt || !near) continue;
      seen.add(clip.id);
      const el = this.element(clip, rt.url);
      const media = getMedia(project, clip.mediaId);
      const inside = t >= clip.start;
      const target = clamp(clip.offset + (t - clip.start) * clip.speed, 0, Math.max(0, (media?.duration ?? 0) - 0.01));
      if (playing && inside) {
        const track = tracks.get(clip.trackId);
        el.playbackRate = clip.speed;
        el.muted = !!track?.muted || !media?.hasAudio;
        el.volume = clamp(clip.volume * fadeFactor(clip, t), 0, 1);
        if (el.paused) {
          if (Math.abs(el.currentTime - target) > 0.05) el.currentTime = target;
          el.play().catch(() => {});
        } else if (Math.abs(el.currentTime - target) > DRIFT_TOLERANCE * Math.max(1, clip.speed)) {
          el.currentTime = target;
        }
      } else {
        if (!el.paused) el.pause();
        const want = inside ? target : clip.offset;
        if (!el.seeking && Math.abs(el.currentTime - want) > 0.001) el.currentTime = want;
      }
    }
    for (const id of [...this.elements.keys()]) if (!seen.has(id)) this.dispose(id);
  }

  private image(mediaId: string, url: string): HTMLImageElement {
    let img = this.images.get(mediaId);
    if (!img) {
      img = new Image();
      img.onload = this.invalidate;
      img.src = url;
      this.images.set(mediaId, img);
    }
    return img;
  }

  private draw() {
    if (!this.canvas || !this.ctx) return;
    const { project, runtime, playhead, playing } = useStore.getState();
    if (this.canvas.width !== project.width || this.canvas.height !== project.height) {
      this.canvas.width = project.width;
      this.canvas.height = project.height;
    }
    drawFrame(this.ctx, project, playhead, (clip) => {
      const rt = clip.mediaId ? runtime[clip.mediaId] : undefined;
      if (!rt) return null;
      if (clip.type === 'image') {
        const img = this.image(clip.mediaId!, rt.url);
        return img.complete && img.naturalWidth ? img : null;
      }
      const el = this.elements.get(clip.id)?.el as HTMLVideoElement | undefined;
      return el && el.readyState >= 2 ? el : null;
    });
    if (playing) this.dirty = true;
  }
}

export const preview = new PreviewEngine();
