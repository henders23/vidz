/**
 * Higher-level operations built on the transcript and waveform: captions,
 * silence removal, a compact project summary and frame snapshots. They work on
 * their own (command palette / buttons) and are also the assistant's tools.
 */
import { Clip, TimeRange, TimelineWord } from '../types';
import { useStore } from '../store';
import * as edit from './edit';
import { FrameSources } from './export';
import { PEAKS_PER_SECOND } from './media';
import { drawFrame } from './render';

const s = () => useStore.getState();
const round = (n: number) => Math.round(n * 1000) / 1000;

export function words(): TimelineWord[] {
  const { project, runtime } = s();
  return edit.timelineWords(project, (id) => runtime[id]?.transcript);
}

/** Transcribe if needed, then return the words on the timeline. */
export async function ensureWords(): Promise<TimelineWord[]> {
  const ok = await s().ensureTranscripts();
  if (!ok) throw new Error('There is no speech on the timeline to transcribe. Add a video or audio clip first.');
  return words();
}

export function silences(options: edit.SilenceOptions = {}): TimeRange[] {
  const { project, runtime } = s();
  return edit.findSilences(project, (id) => runtime[id]?.peaks, PEAKS_PER_SECOND, options).map((r) => ({ start: round(r.start), end: round(r.end) }));
}

export function removeSilences(options: edit.SilenceOptions = {}) {
  const ranges = silences(options);
  const seconds = round(ranges.reduce((n, r) => n + r.end - r.start, 0));
  if (ranges.length) s().commit((p) => edit.rippleCut(p, ranges));
  s().select([]);
  return {
    removed: ranges.length,
    seconds,
    message: ranges.length ? `Removed ${ranges.length} pause${ranges.length === 1 ? '' : 's'} (${seconds.toFixed(1)}s)` : 'No silent pauses found',
  };
}

export async function addCaptions(maxChars?: number) {
  const lines = edit.captionLines(await ensureWords(), maxChars);
  if (!lines.length) return { captions: 0, message: 'No speech was detected, so there is nothing to caption' };
  s().commit((p) => edit.setCaptions(p, lines));
  return { captions: lines.length, message: `Added ${lines.length} captions` };
}

/** Transcript as timed lines (or individual words) for a time window. */
export async function transcript(start = 0, end = Infinity, wordLevel = false) {
  const all = (await ensureWords()).filter((w) => w.end > start && w.start < end);
  if (wordLevel) return all.map((w) => ({ start: round(w.start), end: round(w.end), text: w.text }));
  return edit.captionLines(all, 80).map((l) => ({ start: round(l.start), end: round(l.end), text: l.text }));
}

/** Drop defaults so the summary stays small. */
function summariseClip(c: Clip) {
  const out: Record<string, unknown> = { id: c.id, trackId: c.trackId, type: c.type, start: round(c.start), duration: round(c.duration) };
  if (c.mediaId) out.mediaId = c.mediaId;
  if (c.offset) out.offset = round(c.offset);
  if (c.speed !== 1) out.speed = c.speed;
  if (c.x || c.y) Object.assign(out, { x: round(c.x), y: round(c.y) });
  if (c.scale !== 1) out.scale = round(c.scale);
  if (c.rotation) out.rotation = c.rotation;
  if (c.opacity !== 1) out.opacity = c.opacity;
  if (c.volume !== 1) out.volume = c.volume;
  if (c.fadeIn) out.fadeIn = c.fadeIn;
  if (c.fadeOut) out.fadeOut = c.fadeOut;
  if (c.text) out.text = c.text.content;
  if (c.shape) out.shape = c.shape.kind;
  if (c.effect) out.effect = c.effect;
  if (c.transition) out.transition = c.transition;
  return out;
}

/** A compact, JSON-friendly description of the project for the assistant. */
export function snapshot() {
  const { project, playhead, selection, runtime } = s();
  const captions = project.clips.filter((c) => c.caption);
  return {
    name: project.name,
    width: project.width,
    height: project.height,
    fps: project.fps,
    duration: round(edit.projectDuration(project)),
    playhead: round(playhead),
    selectedClipIds: selection,
    tracks: project.tracks.map((t, i) => ({ id: t.id, name: t.name, kind: t.kind, layer: i === 0 ? 'top' : undefined, muted: t.muted || undefined, hidden: t.hidden || undefined, locked: t.locked || undefined })),
    media: project.media.map((m) => ({ id: m.id, name: m.name, kind: m.kind, duration: round(m.duration), width: m.width || undefined, height: m.height || undefined, hasAudio: m.hasAudio, transcribed: !!runtime[m.id]?.transcript })),
    clips: project.clips.filter((c) => !c.caption).sort((a, b) => a.start - b.start).map(summariseClip),
    captions: captions.length ? { count: captions.length, note: 'Caption clips are omitted here; use timeline_getTranscript to read the words.' } : undefined,
  };
}

/** Render the composited frame at `time` as a base64 JPEG (longest side `maxSide`). */
export async function frameJpeg(time: number, maxSide = 1024): Promise<string> {
  const { project, runtime } = s();
  const k = Math.min(1, maxSide / Math.max(project.width, project.height));
  const canvas = new OffscreenCanvas(Math.round(project.width * k), Math.round(project.height * k));
  const ctx = canvas.getContext('2d')!;
  const sources = new FrameSources(project, runtime);
  try {
    await sources.prepare(edit.renderItems(project, time));
    ctx.setTransform(canvas.width / project.width, 0, 0, canvas.height / project.height, 0, 0);
    drawFrame(ctx, project, time, sources.lookup);
  } finally {
    sources.dispose();
  }
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })).arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
