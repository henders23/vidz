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
import { clipSize, drawFrame } from './render';
import { toSrt, toText, toVtt } from './subtitles';
import { downloadBlob } from './util';
import { simplify, toGray, track, trackCursor } from './track';
import { clipEnd } from '../types';

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
  const names = edit.speakerLabels(s().project, all);
  const who = (key?: string) => (key ? { speaker: names.get(key), speakerKey: key } : {});
  if (wordLevel) return all.map((w) => ({ start: round(w.start), end: round(w.end), text: w.text, ...who(w.speakerKey) }));
  return edit.captionLines(all, 80).map((l) => ({ start: round(l.start), end: round(l.end), text: l.text, ...who(l.speakerKey) }));
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
  if (c.keyframes?.length) {
    // Reported in timeline seconds, the same form clip_setKeyframes takes.
    out.keyframes = c.keyframes.map(({ time, ...v }) => ({ time: round(c.start + time), ...Object.fromEntries(Object.entries(v).filter(([, n]) => n !== undefined).map(([k, n]) => [k, round(n as number)])) }));
    out.motion = c.motion ?? 'smooth';
  }
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

let trackAbort: AbortController | null = null;
export const cancelTracking = () => trackAbort?.abort();

export interface TrackClipOptions {
  /** Timeline time to start from (default: the playhead). */
  from?: number;
  /** Also follow the target getting bigger or smaller. */
  followSize?: boolean;
}

/**
 * Make a clip follow whatever is underneath it, from `from` to the end of the
 * clip, by writing keyframes.
 */
export async function trackClip(clipId: string, { from, followSize }: TrackClipOptions = {}) {
  const { project, runtime, playhead } = s();
  if (s().tracking !== null) throw new Error('A motion track is already running');
  const raw = edit.getClip(project, clipId);
  if (!raw || raw.type === 'audio' || raw.type === 'zoom') throw new Error('Select a blur, spotlight, shape, text or image clip to track with');
  const start = from ?? playhead;
  if (start < raw.start || start >= clipEnd(raw) - 2 / project.fps) throw new Error('Move the playhead onto the clip, over the moment where it sits on its target');
  const trackIndex = project.tracks.findIndex((t) => t.id === raw.trackId);
  const below = new Set(project.tracks.slice(trackIndex + 1).filter((t) => t.kind === 'video' && !t.hidden).map((t) => t.id));
  if (!project.clips.some((c) => below.has(c.trackId) && (c.type === 'video' || c.type === 'image'))) {
    throw new Error('There is no footage on the tracks beneath this clip to follow');
  }

  const clip = edit.resolveClip(raw, start);
  const size = clipSize(clip, project);
  // A cursor highlight is much bigger than the cursor itself, which sits at its centre.
  const cursor = clip.shape?.kind === 'glow';
  const targetW = size.width * clip.scale * (cursor ? 0.3 : 1);
  const targetH = size.height * clip.scale * (cursor ? 0.3 : 1);

  // Analyse greyscale frames of everything beneath the clip: small for speed, but large
  // enough that a small target (like a cursor) still has detail to recognise.
  const longest = Math.max(project.width, project.height);
  const k = Math.min(1, 1280 / longest, Math.max(640 / longest, 28 / Math.max(1, Math.min(targetW, targetH))));
  const canvas = new OffscreenCanvas(Math.round(project.width * k), Math.round(project.height * k));
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const sources = new FrameSources(project, runtime);
  const frameAt = async (time: number) => {
    await sources.prepare(edit.renderItems(project, time).filter((i) => below.has(i.clip.trackId)));
    ctx.setTransform(canvas.width / project.width, 0, 0, canvas.height / project.height, 0, 0);
    drawFrame(ctx, project, time, sources.lookup, { belowTrackId: raw.trackId });
    return toGray(ctx.getImageData(0, 0, canvas.width, canvas.height));
  };

  // Sample on the project's frame grid (about 15 times a second), so the tracker sees
  // exactly the frames that playback and export will show at those times.
  const stride = Math.max(1, Math.round(project.fps / 15));
  const times: number[] = [];
  for (let n = Math.ceil(start * project.fps - 1e-6); n / project.fps < clipEnd(raw) - 1e-3; n += stride) times.push(n / project.fps);
  const box = {
    x: (project.width / 2 + clip.x) * k,
    y: (project.height / 2 + clip.y) * k,
    width: Math.max(8, targetW * k),
    height: Math.max(8, targetH * k),
  };

  trackAbort = new AbortController();
  useStore.setState({ tracking: 0, playing: false });
  try {
    const report = (tracking: number) => useStore.setState({ tracking });
    const result = cursor
      ? await trackCursor(frameAt, times, { x: box.x, y: box.y, size: Math.max(box.width, box.height) }, report, trackAbort.signal)
      : await track(frameAt, times, box, { followSize }, report, trackAbort.signal);
    if (cursor && result.points.every((pt) => pt.x === box.x && pt.y === box.y)) {
      throw new Error('The cursor never seemed to move from there. Put the centre of the highlight exactly on the cursor and try again.');
    }
    if (result.points.length < 2) {
      throw new Error('Nothing distinctive to follow under the box. Place it over something with visible detail and try again.');
    }
    // Keep only the keyframes needed to stay within about 4 canvas pixels of the tracked path.
    // (A cursor highlight is large and soft, so it can be looser.)
    const path = simplify(result.points, (cursor ? 10 : 4) * k, Math.max(box.width, box.height)).map((pt) => ({
      time: pt.time,
      x: pt.x / k - project.width / 2,
      y: pt.y / k - project.height / 2,
      scale: followSize ? pt.scale : undefined,
    }));
    s().commit((p) => edit.setPathFrom(p, clipId, start, path));
    const until = result.lostAt === undefined ? '' : ` It lost the target at ${result.lostAt.toFixed(1)}s; move the box back onto it there and track again.`;
    return { keyframes: path.length, lostAt: result.lostAt, message: `Tracked with ${path.length} keyframes.${until}` };
  } finally {
    sources.dispose();
    trackAbort = null;
    useStore.setState({ tracking: null });
  }
}

/**
 * Add a soft highlight for the mouse cursor, covering the rest of the footage under the
 * playhead. The user drops it on the cursor; Track motion then makes it follow.
 */
export function addCursorHighlight(): string | null {
  const { project, playhead } = s();
  const footage = edit.visibleClips(project, playhead).reverse().find((c) => c.type === 'video');
  if (!footage) throw new Error('Move the playhead onto a screen recording first');
  let clipId: string | null = null;
  s().commit((p) => {
    const added = edit.addShapeClip(p, 'glow', { start: playhead }, clipEnd(footage) - playhead);
    clipId = added.clipId;
    return added.project;
  });
  if (clipId) s().select([clipId]);
  s().setPanel('properties');
  return clipId;
}

export type CaptionFormat = 'srt' | 'vtt' | 'txt';

/**
 * Download the captions as a file. Uses the caption clips on the timeline (so
 * your edits to their wording and timing are included), or the transcript if
 * captions have not been added.
 */
export function exportCaptions(format: CaptionFormat) {
  const { project } = s();
  const clips = project.clips.filter((c) => c.caption && c.text);
  const all = words();
  const names = edit.speakerLabels(project, all);
  // Caption clips are exported exactly as written. Lines built from the transcript name
  // the speaker each time it changes, when speakers have been labelled.
  let lastSpeaker: string | undefined;
  const lines = clips.length
    ? clips.map((c) => ({ start: c.start, end: clipEnd(c), text: c.text!.content }))
    : edit.captionLines(all).map((line) => {
        const changed = names.size > 1 && line.speakerKey !== undefined && line.speakerKey !== lastSpeaker;
        lastSpeaker = line.speakerKey ?? lastSpeaker;
        return changed ? { ...line, text: `${names.get(line.speakerKey!)}: ${line.text}`, newTurn: true } : line;
      });
  if (!lines.length) throw new Error('There is nothing to export yet. Transcribe the video or add captions first.');
  const body = format === 'srt' ? toSrt(lines) : format === 'vtt' ? toVtt(lines) : toText(lines);
  const name = `${project.name.trim() || 'captions'}.${format}`;
  downloadBlob(new Blob([body], { type: format === 'vtt' ? 'text/vtt' : 'text/plain' }), name);
  return { message: `Saved ${name}` };
}

/** Refresh the current project's picture in the project list. */
export async function captureThumbnail() {
  const { project, projects, setThumbnail } = s();
  if (!projects.some((p) => p.id === project.id)) return;
  const duration = edit.projectDuration(project);
  if (duration <= 0) return;
  try {
    setThumbnail(project.id, `data:image/jpeg;base64,${await frameJpeg(Math.min(1, duration / 2), 320)}`);
  } catch {
    // A missing thumbnail is not worth interrupting the user for.
  }
}
