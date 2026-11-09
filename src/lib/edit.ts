/**
 * Pure editing operations. Every function takes a Project and returns a new
 * Project without mutating its input, so they are trivially undoable, testable,
 * and safe to call from automation (the command layer / future AI editing).
 */
import {
  Clip, ClipType, EffectKind, MediaAsset, Project, ShapeKind, Track, TrackKind, Transition, TransitionType, canTransition, clipEnd,
  isOverlay, isVisual,
} from '../types';
import { clamp, uid } from './util';

export const MIN_CLIP = 0.05;
export const DEFAULT_STILL_DURATION = 5;

export function createProject(): Project {
  return {
    id: uid(),
    name: 'Untitled project',
    width: 1920,
    height: 1080,
    fps: 30,
    background: '#000000',
    tracks: [makeTrack('video', 'Video 1'), makeTrack('audio', 'Audio 1')],
    clips: [],
    media: [],
  };
}

function makeTrack(kind: TrackKind, name: string): Track {
  return { id: uid(), kind, name, muted: false, hidden: false, locked: false };
}

export function makeClip(type: ClipType, trackId: string, start: number, duration: number): Clip {
  return {
    id: uid(),
    trackId,
    type,
    start,
    duration,
    offset: 0,
    speed: 1,
    x: 0,
    y: 0,
    scale: 1,
    rotation: 0,
    opacity: 1,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    filters: { brightness: 1, contrast: 1, saturation: 1, blur: 0 },
  };
}

export const projectDuration = (p: Project) => p.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);

export const getClip = (p: Project, id: string) => p.clips.find((c) => c.id === id);
export const getMedia = (p: Project, id?: string) => (id ? p.media.find((m) => m.id === id) : undefined);
export const trackClips = (p: Project, trackId: string, ignoreId?: string) =>
  p.clips.filter((c) => c.trackId === trackId && c.id !== ignoreId).sort((a, b) => a.start - b.start);

const overlaps = (clips: Clip[], start: number, duration: number) =>
  clips.some((c) => start < clipEnd(c) - 1e-6 && start + duration > c.start + 1e-6);

export const isFree = (p: Project, trackId: string, start: number, duration: number, ignoreId?: string) =>
  !overlaps(trackClips(p, trackId, ignoreId), start, duration);

/** Nearest position to `desired` where a clip of `duration` fits on the track. */
export function findFreeStart(p: Project, trackId: string, desired: number, duration: number, ignoreId?: string): number {
  const clips = trackClips(p, trackId, ignoreId);
  desired = Math.max(0, desired);
  if (!overlaps(clips, desired, duration)) return desired;
  const candidates = [0, ...clips.map(clipEnd), ...clips.map((c) => c.start - duration)].filter(
    (s) => s >= 0 && !overlaps(clips, s, duration),
  );
  return candidates.reduce((best, s) => (Math.abs(s - desired) < Math.abs(best - desired) ? s : best), candidates[0]);
}

export function addTrack(p: Project, kind: TrackKind): { project: Project; track: Track } {
  const n = p.tracks.filter((t) => t.kind === kind).length + 1;
  const track = makeTrack(kind, `${kind === 'video' ? 'Video' : 'Audio'} ${n}`);
  // New video tracks stack on top; new audio tracks go to the bottom.
  const tracks = kind === 'video' ? [track, ...p.tracks] : [...p.tracks, track];
  return { project: { ...p, tracks }, track };
}

export function removeTrack(p: Project, trackId: string): Project {
  const track = p.tracks.find((t) => t.id === trackId);
  if (!track || p.tracks.filter((t) => t.kind === track.kind).length <= 1) return p;
  return { ...p, tracks: p.tracks.filter((t) => t.id !== trackId), clips: p.clips.filter((c) => c.trackId !== trackId) };
}

export function updateTrack(p: Project, trackId: string, patch: Partial<Track>): Project {
  return { ...p, tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t)) };
}

const kindFor = (type: ClipType): TrackKind => (type === 'audio' ? 'audio' : 'video');

/**
 * Pick a track for a new clip. Footage fills the lowest free video track;
 * overlays (text/shapes) always land above anything already visible at that time.
 */
function pickTrack(p: Project, type: ClipType, start: number, duration: number): { project: Project; trackId: string } {
  const kind = kindFor(type);
  const usable = (t: Track) => t.kind === kind && !t.locked && isFree(p, t.id, start, duration);
  let candidates = p.tracks.filter(usable);
  if (kind === 'video') {
    candidates = candidates.reverse(); // bottom-most first
    if (isOverlay(type)) {
      const topBusy = p.tracks.findIndex((t) => t.kind === 'video' && !isFree(p, t.id, start, duration));
      if (topBusy !== -1) candidates = candidates.filter((t) => p.tracks.indexOf(t) < topBusy);
    }
  }
  if (candidates.length) return { project: p, trackId: candidates[0].id };
  const { project, track } = addTrack(p, kind);
  return { project, trackId: track.id };
}

export interface Placement {
  trackId?: string;
  start: number;
}

function place(p: Project, type: ClipType, duration: number, at: Placement): { project: Project; trackId: string; start: number } {
  const target = at.trackId ? p.tracks.find((t) => t.id === at.trackId) : undefined;
  if (target && target.kind === kindFor(type) && !target.locked) {
    return { project: p, trackId: target.id, start: findFreeStart(p, target.id, at.start, duration) };
  }
  const start = Math.max(0, at.start);
  return { ...pickTrack(p, type, start, duration), start };
}

export function addMediaClip(p: Project, mediaId: string, at: Placement): { project: Project; clipId: string | null } {
  const media = getMedia(p, mediaId);
  if (!media) return { project: p, clipId: null };
  const duration = media.kind === 'image' ? DEFAULT_STILL_DURATION : Math.max(MIN_CLIP, media.duration);
  const placed = place(p, media.kind, duration, at);
  const clip = makeClip(media.kind, placed.trackId, placed.start, duration);
  clip.mediaId = mediaId;
  return { project: { ...placed.project, clips: [...placed.project.clips, clip] }, clipId: clip.id };
}

export function addTextClip(p: Project, at: Placement, content = 'Your text here'): { project: Project; clipId: string } {
  const placed = place(p, 'text', DEFAULT_STILL_DURATION, at);
  const clip = makeClip('text', placed.trackId, placed.start, DEFAULT_STILL_DURATION);
  clip.text = {
    content,
    fontFamily: 'Inter, system-ui, sans-serif',
    fontSize: Math.round(p.height / 10),
    color: '#ffffff',
    bold: true,
    italic: false,
    align: 'center',
    background: '',
    outline: '#000000',
    outlineWidth: 0,
  };
  return { project: { ...placed.project, clips: [...placed.project.clips, clip] }, clipId: clip.id };
}

export function addShapeClip(p: Project, kind: ShapeKind, at: Placement): { project: Project; clipId: string } {
  const duration = kind === 'pulse' ? 1.8 : DEFAULT_STILL_DURATION;
  const placed = place(p, 'shape', duration, at);
  const clip = makeClip('shape', placed.trackId, placed.start, duration);
  const unit = p.height / 10;
  if (kind === 'pulse') {
    clip.shape = { kind, width: unit * 2, height: unit * 2, fill: '', stroke: '#ffd23d', strokeWidth: Math.round(unit / 8), radius: 0 };
  } else {
    clip.shape = {
      kind,
      width: kind === 'arrow' ? unit * 4 : unit * 5,
      height: kind === 'arrow' ? unit : unit * 3,
      fill: kind === 'arrow' ? '#ff4d6d' : '',
      stroke: '#ff4d6d',
      strokeWidth: kind === 'arrow' ? 0 : Math.round(unit / 8),
      radius: kind === 'rect' ? Math.round(unit / 5) : 0,
    };
  }
  return { project: { ...placed.project, clips: [...placed.project.clips, clip] }, clipId: clip.id };
}

/** A zoom-and-pan: everything beneath it zooms into the chosen area, easing in and out. */
export function addZoomClip(p: Project, at: Placement): { project: Project; clipId: string } {
  const placed = place(p, 'zoom', 4, at);
  const clip = makeClip('zoom', placed.trackId, placed.start, 4);
  clip.scale = 0.5;
  clip.fadeIn = 0.6;
  clip.fadeOut = 0.6;
  return { project: { ...placed.project, clips: [...placed.project.clips, clip] }, clipId: clip.id };
}

export const EFFECT_DEFAULT_AMOUNT: Record<EffectKind, number> = { blur: 24, pixelate: 24, spotlight: 0.7 };

/** A blur / pixelate / spotlight region applied to everything beneath it. */
export function addEffectClip(p: Project, kind: EffectKind, at: Placement): { project: Project; clipId: string } {
  const placed = place(p, 'effect', DEFAULT_STILL_DURATION, at);
  const clip = makeClip('effect', placed.trackId, placed.start, DEFAULT_STILL_DURATION);
  const unit = p.height / 10;
  clip.effect = {
    kind,
    region: kind === 'spotlight' ? 'ellipse' : 'rect',
    width: unit * (kind === 'spotlight' ? 4 : 5),
    height: unit * (kind === 'spotlight' ? 4 : 2),
    amount: EFFECT_DEFAULT_AMOUNT[kind],
  };
  return { project: { ...placed.project, clips: [...placed.project.clips, clip] }, clipId: clip.id };
}

/** Set (or with `type: null`, remove) the transition a clip enters with. */
export function setTransition(p: Project, id: string, type: TransitionType | null, duration = 0.5): Project {
  const clip = getClip(p, id);
  if (!clip || !canTransition(clip)) return p;
  const transition: Transition | undefined = type ? { type, duration: clamp(duration, 0.1, Math.min(5, clip.duration)) } : undefined;
  return updateClip(p, id, { transition });
}

export function updateClip(p: Project, id: string, patch: Partial<Clip>): Project {
  return { ...p, clips: p.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) };
}

export function moveClip(p: Project, id: string, start: number, trackId?: string): Project {
  const clip = getClip(p, id);
  if (!clip) return p;
  let target = trackId ? p.tracks.find((t) => t.id === trackId) : undefined;
  if (!target || target.kind !== kindFor(clip.type) || target.locked) target = p.tracks.find((t) => t.id === clip.trackId)!;
  const free = findFreeStart(p, target.id, start, clip.duration, id);
  return updateClip(p, id, { start: free, trackId: target.id });
}

/** Seconds of source material available to a clip, or Infinity for stills/text. */
function sourceLength(p: Project, clip: Clip): number {
  if (clip.type !== 'video' && clip.type !== 'audio') return Infinity;
  return getMedia(p, clip.mediaId)?.duration ?? Infinity;
}

export function trimClip(p: Project, id: string, edge: 'start' | 'end', time: number): Project {
  const clip = getClip(p, id);
  if (!clip) return p;
  const others = trackClips(p, clip.trackId, id);
  const end = clipEnd(clip);
  if (edge === 'start') {
    const prevEnd = Math.max(0, ...others.filter((c) => clipEnd(c) <= clip.start + 1e-6).map(clipEnd));
    const sourceLimit = clip.start - clip.offset / clip.speed;
    const start = clamp(time, Math.max(prevEnd, sourceLimit, 0), end - MIN_CLIP);
    const isTimed = clip.type === 'video' || clip.type === 'audio';
    return updateClip(p, id, {
      start,
      duration: end - start,
      offset: isTimed ? Math.max(0, clip.offset + (start - clip.start) * clip.speed) : 0,
    });
  }
  const nextStart = Math.min(Infinity, ...others.filter((c) => c.start >= end - 1e-6).map((c) => c.start));
  const sourceLimit = clip.start + (sourceLength(p, clip) - clip.offset) / clip.speed;
  const newEnd = clamp(time, clip.start + MIN_CLIP, Math.min(nextStart, sourceLimit));
  return updateClip(p, id, { duration: newEnd - clip.start });
}

export function splitClip(p: Project, id: string, time: number): Project {
  const clip = getClip(p, id);
  if (!clip || time <= clip.start + MIN_CLIP || time >= clipEnd(clip) - MIN_CLIP) return p;
  const firstDuration = time - clip.start;
  const first: Clip = { ...clip, duration: firstDuration, fadeOut: 0 };
  const second: Clip = {
    ...clip,
    id: uid(),
    start: time,
    duration: clip.duration - firstDuration,
    offset: clip.type === 'video' || clip.type === 'audio' ? clip.offset + firstDuration * clip.speed : 0,
    fadeIn: 0,
    transition: undefined,
  };
  return { ...p, clips: p.clips.flatMap((c) => (c.id === id ? [first, second] : [c])) };
}

/** Split every unlocked clip under `time` (or just the given ids). */
export function splitAt(p: Project, time: number, ids?: string[]): Project {
  const locked = new Set(p.tracks.filter((t) => t.locked).map((t) => t.id));
  const targets = p.clips.filter(
    (c) => (!ids?.length || ids.includes(c.id)) && !locked.has(c.trackId) && time > c.start && time < clipEnd(c),
  );
  return targets.reduce((acc, c) => splitClip(acc, c.id, time), p);
}

export function deleteClips(p: Project, ids: string[], ripple = false): Project {
  const doomed = p.clips.filter((c) => ids.includes(c.id));
  let clips = p.clips.filter((c) => !ids.includes(c.id));
  if (ripple) {
    // Close each gap by pulling later clips on the same track to the left.
    for (const gone of [...doomed].sort((a, b) => b.start - a.start)) {
      clips = clips.map((c) =>
        c.trackId === gone.trackId && c.start >= clipEnd(gone) - 1e-6 ? { ...c, start: c.start - gone.duration } : c,
      );
    }
  }
  return { ...p, clips };
}

export function duplicateClip(p: Project, id: string): { project: Project; clipId: string | null } {
  const clip = getClip(p, id);
  if (!clip) return { project: p, clipId: null };
  const copy: Clip = { ...clip, id: uid(), start: findFreeStart(p, clip.trackId, clipEnd(clip), clip.duration) };
  return { project: { ...p, clips: [...p.clips, copy] }, clipId: copy.id };
}

export function setClipSpeed(p: Project, id: string, speed: number): Project {
  const clip = getClip(p, id);
  if (!clip || (clip.type !== 'video' && clip.type !== 'audio')) return p;
  speed = clamp(speed, 0.1, 8);
  const sourceSpan = clip.duration * clip.speed;
  const next = Math.min(Infinity, ...trackClips(p, clip.trackId, id).filter((c) => c.start >= clip.start).map((c) => c.start));
  const duration = Math.max(MIN_CLIP, Math.min(sourceSpan / speed, next - clip.start));
  return updateClip(p, id, { speed, duration });
}

export function removeMedia(p: Project, mediaId: string): Project {
  return { ...p, media: p.media.filter((m) => m.id !== mediaId), clips: p.clips.filter((c) => c.mediaId !== mediaId) };
}

export function addMedia(p: Project, asset: MediaAsset): Project {
  return { ...p, media: [...p.media, asset] };
}

/** Fade multiplier (0..1) for a clip at an absolute timeline time. */
export function fadeFactor(clip: Clip, time: number): number {
  const t = time - clip.start;
  let f = 1;
  if (clip.fadeIn > 0) f = Math.min(f, t / clip.fadeIn);
  if (clip.fadeOut > 0) f = Math.min(f, (clip.duration - t) / clip.fadeOut);
  return clamp(f, 0, 1);
}

/** Visual clips active at `time`, ordered bottom layer first. */
export function visibleClips(p: Project, time: number): Clip[] {
  const order = new Map(p.tracks.map((t, i) => [t.id, i]));
  const hidden = new Set(p.tracks.filter((t) => t.hidden).map((t) => t.id));
  return p.clips
    .filter((c) => isVisual(c) && !hidden.has(c.trackId) && time >= c.start && time < clipEnd(c))
    .sort((a, b) => order.get(b.trackId)! - order.get(a.trackId)!);
}

const ADJACENT = 0.02;
const ease = (t: number) => t * t * (3 - 2 * t);

export interface RenderItem {
  clip: Clip;
  /** Seconds since the clip's start (clamped to its last frame while held). */
  localTime: number;
  /** True for a finished clip kept on screen while the next clip transitions over it. */
  held: boolean;
  transition?: { type: TransitionType; progress: number; role: 'in' | 'out' };
}

/** Everything to draw at `time`, bottom layer first, including transition state. */
export function renderItems(p: Project, time: number): RenderItem[] {
  const order = new Map(p.tracks.map((t, i) => [t.id, i]));
  const hidden = new Set(p.tracks.filter((t) => t.hidden).map((t) => t.id));
  const items: RenderItem[] = [];
  for (const clip of p.clips) {
    if (!isVisual(clip) || hidden.has(clip.trackId) || time < clip.start || time >= clipEnd(clip)) continue;
    const item: RenderItem = { clip, localTime: time - clip.start, held: false };
    const tr = canTransition(clip) ? clip.transition : undefined;
    if (tr && item.localTime < tr.duration) {
      const progress = ease(clamp(item.localTime / tr.duration, 0, 1));
      item.transition = { type: tr.type, progress, role: 'in' };
      const previous = p.clips.find(
        (c) => c.trackId === clip.trackId && c.id !== clip.id && canTransition(c) && Math.abs(clipEnd(c) - clip.start) < ADJACENT,
      );
      if (previous) {
        items.push({
          clip: previous,
          localTime: Math.max(0, previous.duration - 1 / p.fps),
          held: true,
          transition: { type: tr.type, progress, role: 'out' },
        });
      }
    }
    items.push(item);
  }
  return items.sort((a, b) => order.get(b.clip.trackId)! - order.get(a.clip.trackId)! || a.clip.start - b.clip.start);
}

/** Centre of a zoom clip's target area, kept inside the canvas. */
export function zoomCentre(clip: Clip, p: Project): { x: number; y: number } {
  const s = clamp(clip.scale, 0.05, 1);
  const mx = (p.width / 2) * (1 - s);
  const my = (p.height / 2) * (1 - s);
  return { x: clamp(clip.x, -mx, mx), y: clamp(clip.y, -my, my) };
}

/** Uniform scale + translation mapping canvas coordinates to on-screen coordinates. */
export interface ViewTransform {
  k: number;
  tx: number;
  ty: number;
}

/**
 * Combined effect of every zoom clip above `trackId` at `time`.
 * `bypassId` leaves one zoom clip out (used while its target area is being edited).
 */
export function zoomTransform(p: Project, time: number, trackId: string, bypassId?: string): ViewTransform {
  const view: ViewTransform = { k: 1, tx: 0, ty: 0 };
  const cx = p.width / 2;
  const cy = p.height / 2;
  for (const track of p.tracks) {
    if (track.id === trackId) break;
    if (track.hidden) continue;
    for (const clip of p.clips) {
      if (clip.type !== 'zoom' || clip.trackId !== track.id || clip.id === bypassId || time < clip.start || time >= clipEnd(clip)) continue;
      const progress = ease(fadeFactor(clip, time));
      const centre = zoomCentre(clip, p);
      const size = 1 + (clamp(clip.scale, 0.05, 1) - 1) * progress;
      const kz = 1 / size;
      // screen = kz * (pt - (canvasCentre + focus)) + canvasCentre, composed onto the zooms above.
      const tzx = cx - kz * (cx + centre.x * progress);
      const tzy = cy - kz * (cy + centre.y * progress);
      view.tx += view.k * tzx;
      view.ty += view.k * tzy;
      view.k *= kz;
    }
  }
  return view;
}
