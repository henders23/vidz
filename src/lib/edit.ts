/**
 * Pure editing operations. Every function takes a Project and returns a new
 * Project without mutating its input, so they are trivially undoable, testable,
 * and safe to call from automation (the command layer / future AI editing).
 */
import { Clip, ClipType, MediaAsset, Project, ShapeKind, Track, TrackKind, clipEnd, isVisual } from '../types';
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
    if (type === 'text' || type === 'shape') {
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
  const placed = place(p, 'shape', DEFAULT_STILL_DURATION, at);
  const clip = makeClip('shape', placed.trackId, placed.start, DEFAULT_STILL_DURATION);
  const unit = p.height / 10;
  clip.shape = {
    kind,
    width: kind === 'arrow' ? unit * 4 : unit * 5,
    height: kind === 'arrow' ? unit : unit * 3,
    fill: kind === 'arrow' ? '#ff4d6d' : '',
    stroke: '#ff4d6d',
    strokeWidth: kind === 'arrow' ? 0 : Math.round(unit / 8),
    radius: kind === 'rect' ? Math.round(unit / 5) : 0,
  };
  return { project: { ...placed.project, clips: [...placed.project.clips, clip] }, clipId: clip.id };
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
