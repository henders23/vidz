/**
 * Command registry. Every user-facing action is a named command with a
 * description and (optionally) a JSON-schema for its parameters. The keyboard
 * shortcuts, the command palette and `window.vidz` all go through here, which
 * is also the surface an AI agent will use to edit a project.
 */
import { Clip, EffectKind, Project, ShapeKind, TransitionType, canTransition, clipEnd } from '../types';
import { useStore } from '../store';
import * as edit from './edit';
import { kindOf } from './media';
import * as smart from './smart';

type Params = Record<string, unknown>;

export interface Command {
  id: string;
  title: string;
  description: string;
  shortcut?: string;
  /** JSON schema of the parameters. Commands without required params appear in the palette. */
  params?: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  /** Not shown in the command palette (data lookups meant for automation). */
  hidden?: boolean;
  /** May be async. A returned `{ message }` is shown to the user when run from the UI. */
  run: (params: Params) => unknown;
}

const s = () => useStore.getState();
const frame = () => 1 / s().project.fps;

export function openFilePicker() {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = 'video/*,audio/*,image/*,.mkv,.mov';
  input.onchange = () => input.files && void s().importFiles(Array.from(input.files));
  input.click();
}

export function filesFromDrop(e: { dataTransfer: DataTransfer | null }): File[] {
  return Array.from(e.dataTransfer?.files ?? []).filter((f) => kindOf(f));
}

/** Add a library item to the timeline and select it. */
export function addMediaToTimeline(mediaId: string, at?: { start: number; trackId?: string }): string | null {
  let clipId: string | null = null;
  s().commit((p) => {
    const result = edit.addMediaClip(p, mediaId, at ?? { start: s().playhead });
    clipId = result.clipId;
    return result.project;
  });
  if (clipId) s().select([clipId]);
  return clipId;
}

function insert(fn: (p: Project) => { project: Project; clipId: string | null }): string | null {
  let clipId: string | null = null;
  s().commit((p) => {
    const result = fn(p);
    clipId = result.clipId;
    return result.project;
  });
  if (clipId) s().select([clipId]);
  return clipId;
}

const addShape = (kind: ShapeKind) => insert((p) => edit.addShapeClip(p, kind, { start: s().playhead }));
const addEffect = (kind: EffectKind) => insert((p) => edit.addEffectClip(p, kind, { start: s().playhead }));

/** Give a clip a cross-dissolve: the selected clip, or else the top-most clip under the playhead. */
function addTransition() {
  const { project, selection, playhead } = s();
  const selected = selection.length === 1 ? edit.getClip(project, selection[0]) : undefined;
  const target = selected && canTransition(selected) ? selected : edit.visibleClips(project, playhead).reverse().find(canTransition);
  if (!target) return s().toast('Select a clip to add a transition to');
  if (!target.transition) s().commit((p) => edit.setTransition(p, target.id, 'dissolve'));
  s().select([target.id]);
  s().setPlayhead(target.start);
  s().toast('Transition added at the start of the clip. Change its style in Properties.');
}

function zoomToFit() {
  const duration = edit.projectDuration(s().project);
  const width = document.querySelector('.tl-scroll')?.clientWidth ?? 1000;
  s().setZoom(duration > 0 ? (width - 148 - 48) / duration : 80);
  document.querySelector('.tl-scroll')?.scrollTo({ left: 0 });
}

function seekToEdit(direction: 1 | -1) {
  const { project, playhead } = s();
  const points = [...new Set([0, ...project.clips.flatMap((c) => [c.start, clipEnd(c)])])].sort((a, b) => a - b);
  const next = direction > 0 ? points.find((t) => t > playhead + 1e-4) : points.reverse().find((t) => t < playhead - 1e-4);
  if (next !== undefined) s().setPlayhead(next);
}

const num = { type: 'number' };
const str = { type: 'string' };

export const commands: Command[] = [
  { id: 'playback.toggle', title: 'Play / Pause', description: 'Toggle playback.', shortcut: 'Space', run: () => s().setPlaying(!s().playing) },
  { id: 'playback.start', title: 'Go to start', description: 'Move the playhead to the beginning.', shortcut: 'Home', run: () => s().setPlayhead(0) },
  { id: 'playback.end', title: 'Go to end', description: 'Move the playhead to the end of the project.', shortcut: 'End', run: () => s().setPlayhead(edit.projectDuration(s().project)) },
  { id: 'playback.nextFrame', title: 'Next frame', description: 'Step forward one frame.', shortcut: 'ArrowRight', run: () => s().setPlayhead(s().playhead + frame()) },
  { id: 'playback.prevFrame', title: 'Previous frame', description: 'Step back one frame.', shortcut: 'ArrowLeft', run: () => s().setPlayhead(s().playhead - frame()) },
  { id: 'playback.nextEdit', title: 'Jump to next edit', description: 'Move the playhead to the next clip edge.', shortcut: 'Shift+ArrowRight', run: () => seekToEdit(1) },
  { id: 'playback.prevEdit', title: 'Jump to previous edit', description: 'Move the playhead to the previous clip edge.', shortcut: 'Shift+ArrowLeft', run: () => seekToEdit(-1) },
  {
    id: 'playback.seek',
    title: 'Seek',
    description: 'Move the playhead to a time in seconds.',
    params: { type: 'object', properties: { time: num }, required: ['time'] },
    run: ({ time }) => s().setPlayhead(Number(time)),
  },

  { id: 'edit.undo', title: 'Undo', description: 'Undo the last edit.', shortcut: 'Mod+Z', run: () => s().undo() },
  { id: 'edit.redo', title: 'Redo', description: 'Redo the last undone edit.', shortcut: 'Mod+Shift+Z', run: () => s().redo() },
  {
    id: 'edit.split',
    title: 'Split at playhead',
    description: 'Split the selected clips at the playhead, or every clip under the playhead if nothing is selected.',
    shortcut: 'S',
    run: () => s().commit((p) => edit.splitAt(p, s().playhead, s().selection)),
  },
  {
    id: 'edit.delete',
    title: 'Delete selected clips',
    description: 'Remove the selected clips, leaving a gap.',
    shortcut: 'Delete',
    run: () => {
      const ids = s().selection;
      s().commit((p) => edit.deleteClips(p, ids));
      s().select([]);
    },
  },
  {
    id: 'edit.rippleDelete',
    title: 'Ripple delete',
    description: 'Remove the selected clips and close the gap they leave.',
    shortcut: 'Shift+Delete',
    run: () => {
      const ids = s().selection;
      s().commit((p) => edit.deleteClips(p, ids, true));
      s().select([]);
    },
  },
  {
    id: 'edit.duplicate',
    title: 'Duplicate clip',
    description: 'Duplicate the selected clip right after itself.',
    shortcut: 'Mod+D',
    run: () => {
      const [id] = s().selection;
      if (id) insert((p) => edit.duplicateClip(p, id));
    },
  },
  { id: 'edit.selectAll', title: 'Select all clips', description: 'Select every clip on the timeline.', shortcut: 'Mod+A', run: () => s().select(s().project.clips.map((c) => c.id)) },
  { id: 'edit.deselect', title: 'Deselect', description: 'Clear the selection.', shortcut: 'Escape', run: () => s().select([]) },

  { id: 'insert.text', title: 'Add text', description: 'Add a text title at the playhead.', shortcut: 'T', run: () => insert((p) => edit.addTextClip(p, { start: s().playhead })) },
  { id: 'insert.rect', title: 'Add rectangle', description: 'Add a rectangle highlight at the playhead.', run: () => addShape('rect') },
  { id: 'insert.ellipse', title: 'Add ellipse', description: 'Add an ellipse highlight at the playhead.', run: () => addShape('ellipse') },
  { id: 'insert.arrow', title: 'Add arrow', description: 'Add an arrow callout at the playhead.', run: () => addShape('arrow') },
  { id: 'insert.zoom', title: 'Add zoom', description: 'Zoom and pan into an area of the video at the playhead.', shortcut: 'Z', run: () => insert((p) => edit.addZoomClip(p, { start: s().playhead })) },
  { id: 'insert.blur', title: 'Add blur', description: 'Blur a region to hide sensitive information.', shortcut: 'B', run: () => addEffect('blur') },
  { id: 'insert.pixelate', title: 'Add pixelate', description: 'Pixelate a region to hide sensitive information.', run: () => addEffect('pixelate') },
  { id: 'insert.spotlight', title: 'Add spotlight', description: 'Dim everything except a highlighted region.', shortcut: 'L', run: () => addEffect('spotlight') },
  { id: 'insert.pulse', title: 'Add click pulse', description: 'Add an animated ring that draws attention to a click or a spot.', shortcut: 'P', run: () => addShape('pulse') },
  {
    id: 'insert.cursorHighlight',
    title: 'Add cursor highlight',
    description: 'Add a soft highlight for the mouse cursor over the rest of the clip under the playhead. Returns the new clip id; set its x/y to the cursor position, then call clip_track to make it follow the cursor.',
    shortcut: 'C',
    run: () => {
      const clipId = smart.addCursorHighlight();
      return { clipId, message: 'Drag the highlight onto your cursor, then choose Track motion to make it follow.' };
    },
  },
  { id: 'clip.addTransition', title: 'Add transition', description: 'Add a transition into the selected clip (or the clip under the playhead).', shortcut: 'X', run: addTransition },
  { id: 'track.addVideo', title: 'Add video track', description: 'Add a new video/overlay track on top.', run: () => s().commit((p) => edit.addTrack(p, 'video').project) },
  { id: 'track.addAudio', title: 'Add audio track', description: 'Add a new audio track.', run: () => s().commit((p) => edit.addTrack(p, 'audio').project) },

  { id: 'view.zoomIn', title: 'Zoom in timeline', description: 'Zoom the timeline in.', shortcut: '=', run: () => s().setZoom(s().pxPerSec * 1.4) },
  { id: 'view.zoomOut', title: 'Zoom out timeline', description: 'Zoom the timeline out.', shortcut: '-', run: () => s().setZoom(s().pxPerSec / 1.4) },
  { id: 'view.zoomFit', title: 'Zoom to fit', description: 'Fit the whole project in the timeline.', shortcut: 'Shift+Z', run: zoomToFit },
  { id: 'view.palette', title: 'Command palette', description: 'Search every action.', shortcut: 'Mod+K', run: () => s().setDialog('palette') },
  { id: 'view.shortcuts', title: 'Keyboard shortcuts', description: 'Show all keyboard shortcuts.', shortcut: 'Shift+?', run: () => s().setDialog('shortcuts') },

  { id: 'file.import', title: 'Import media', description: 'Choose video, audio or image files to import.', shortcut: 'Mod+I', run: openFilePicker },
  { id: 'file.record', title: 'Record screen', description: 'Open the screen recorder.', shortcut: 'R', run: () => s().setDialog('record') },
  { id: 'file.export', title: 'Export video', description: 'Open the export dialog.', shortcut: 'Mod+E', run: () => s().setDialog('export') },

  // Parameterised commands: the automation / AI surface.
  {
    id: 'timeline.addMedia',
    title: 'Add media to timeline',
    description: 'Place a media library item on the timeline.',
    params: { type: 'object', properties: { mediaId: str, start: num, trackId: str }, required: ['mediaId'] },
    run: ({ mediaId, start, trackId }) =>
      addMediaToTimeline(String(mediaId), { start: Number(start ?? s().playhead), trackId: trackId as string | undefined }),
  },
  {
    id: 'timeline.addText',
    title: 'Add text clip',
    description: 'Add a text clip with the given content.',
    params: { type: 'object', properties: { content: str, start: num, duration: num }, required: ['content'] },
    run: ({ content, start, duration }) => {
      const id = insert((p) => edit.addTextClip(p, { start: Number(start ?? s().playhead) }, String(content)));
      if (id && duration) s().mutate((p) => edit.updateClip(p, id, { duration: Number(duration) }));
      return id;
    },
  },
  {
    id: 'clip.update',
    title: 'Update clip properties',
    description: 'Patch any clip properties (x, y, scale, rotation, opacity, volume, fadeIn, fadeOut, filters, text, shape, effect).',
    params: { type: 'object', properties: { clipId: str, patch: { type: 'object' } }, required: ['clipId', 'patch'] },
    run: ({ clipId, patch }) =>
      s().commit((p) => {
        // On an animated clip, transform changes must land in a keyframe or they would be ignored.
        const { x, y, scale, rotation, opacity, ...rest } = patch as Partial<Clip>;
        const transform = Object.fromEntries(Object.entries({ x, y, scale, rotation, opacity }).filter(([, v]) => v !== undefined));
        const updated = edit.updateClip(p, String(clipId), rest);
        return Object.keys(transform).length ? edit.applyTransform(updated, String(clipId), s().playhead, transform) : updated;
      }),
  },
  {
    id: 'clip.move',
    title: 'Move clip',
    description: 'Move a clip to a new start time and optionally another track.',
    params: { type: 'object', properties: { clipId: str, start: num, trackId: str }, required: ['clipId', 'start'] },
    run: ({ clipId, start, trackId }) => s().commit((p) => edit.moveClip(p, String(clipId), Number(start), trackId as string | undefined)),
  },
  {
    id: 'clip.trim',
    title: 'Trim clip',
    description: 'Move the start or end edge of a clip to a timeline time.',
    params: { type: 'object', properties: { clipId: str, edge: { enum: ['start', 'end'] }, time: num }, required: ['clipId', 'edge', 'time'] },
    run: ({ clipId, edge, time }) => s().commit((p) => edit.trimClip(p, String(clipId), edge as 'start' | 'end', Number(time))),
  },
  {
    id: 'clip.split',
    title: 'Split clip at time',
    description: 'Split one clip at a timeline time.',
    params: { type: 'object', properties: { clipId: str, time: num }, required: ['clipId', 'time'] },
    run: ({ clipId, time }) => s().commit((p) => edit.splitClip(p, String(clipId), Number(time))),
  },
  {
    id: 'clip.setSpeed',
    title: 'Set clip speed',
    description: 'Change the playback speed of a video or audio clip (0.1 - 8).',
    params: { type: 'object', properties: { clipId: str, speed: num }, required: ['clipId', 'speed'] },
    run: ({ clipId, speed }) => s().commit((p) => edit.setClipSpeed(p, String(clipId), Number(speed))),
  },
  {
    id: 'clip.addKeyframe',
    title: 'Add keyframe',
    description: 'Add a keyframe to the selected clip at the playhead, to start animating its position, size, rotation or opacity.',
    shortcut: 'K',
    run: () => {
      const { project, selection, playhead } = s();
      const clip = selection.length === 1 ? edit.getClip(project, selection[0]) : undefined;
      if (!clip || clip.type === 'audio') return { message: 'Select a clip to animate first' };
      if (playhead < clip.start || playhead > clipEnd(clip)) return { message: 'Move the playhead onto the clip to add a keyframe there' };
      s().commit((p) => edit.setKeyframe(p, clip.id, playhead));
      s().setPanel('properties');
      return { message: 'Keyframe added. Move the playhead, then move or resize the clip to animate it.' };
    },
  },
  {
    id: 'clip.track',
    title: 'Track motion',
    description:
      'Make a clip automatically follow whatever is underneath it (for example keep a blur on a face or a spotlight on the cursor). Position the clip over the target first; it is tracked from `start` (default: the playhead) to the end of the clip and position keyframes are written. Returns lostAt if the target could not be followed all the way.',
    params: { type: 'object', properties: { clipId: str, start: num, followSize: { type: 'boolean', description: 'Also follow the target getting bigger or smaller.' } } },
    run: async ({ clipId, start, followSize }) => {
      const id = (clipId as string | undefined) ?? (s().selection.length === 1 ? s().selection[0] : undefined);
      if (!id) throw new Error('Select the clip that should follow something first');
      try {
        return await smart.trackClip(id, { from: start === undefined ? undefined : Number(start), followSize: !!followSize });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return { message: 'Tracking cancelled' };
        throw err;
      }
    },
  },
  {
    id: 'clip.setKeyframes',
    title: 'Set clip animation',
    description:
      'Replace a clip\'s keyframes so it moves, resizes, rotates or fades over time, for example to keep a blur or spotlight on a moving target, pan a zoom, or slide a title in. Each keyframe gives a timeline time in seconds plus any of x, y (offset from canvas centre in pixels), scale, rotation, opacity, and width/height for effect regions and shapes; omitted properties keep the clip\'s current value. Pass an empty array to remove the animation.',
    params: {
      type: 'object',
      properties: {
        clipId: str,
        keyframes: {
          type: 'array',
          items: { type: 'object', properties: { time: num, x: num, y: num, scale: num, rotation: num, opacity: num, width: num, height: num }, required: ['time'] },
        },
        motion: { enum: ['smooth', 'linear'], description: 'smooth (default) flows through the keyframes; linear moves at constant speed between them, which suits tracking.' },
      },
      required: ['clipId', 'keyframes'],
    },
    run: ({ clipId, keyframes, motion }) =>
      s().commit((p) => edit.setKeyframes(p, String(clipId), keyframes as { time: number }[], motion as Clip['motion'])),
  },
  {
    id: 'clip.setTransition',
    title: 'Set clip transition',
    description: 'Set how a clip enters: dissolve, wipe, push, zoom or dip. Pass type "none" to remove it.',
    params: {
      type: 'object',
      properties: { clipId: str, type: { enum: ['dissolve', 'wipe', 'push', 'zoom', 'dip', 'none'] }, duration: num },
      required: ['clipId', 'type'],
    },
    run: ({ clipId, type, duration }) =>
      s().commit((p) => edit.setTransition(p, String(clipId), type === 'none' ? null : (type as TransitionType), Number(duration ?? 0.5))),
  },
  {
    id: 'timeline.addZoom',
    title: 'Add zoom at time',
    description: 'Zoom into an area. x/y are the centre of the area as an offset from the canvas centre in pixels; level is the magnification (2 = 2x).',
    params: { type: 'object', properties: { start: num, duration: num, level: num, x: num, y: num }, required: ['start'] },
    run: ({ start, duration, level, x, y }) => {
      const id = insert((p) => edit.addZoomClip(p, { start: Number(start) }));
      if (id) s().mutate((p) => edit.updateClip(p, id, { duration: Number(duration ?? 4), scale: 1 / Math.max(1, Number(level ?? 2)), x: Number(x ?? 0), y: Number(y ?? 0) }));
      return id;
    },
  },
  {
    id: 'timeline.addEffect',
    title: 'Add effect region at time',
    description: 'Add a blur, pixelate or spotlight region. x/y are the centre offset from the canvas centre in pixels.',
    params: {
      type: 'object',
      properties: { kind: { enum: ['blur', 'pixelate', 'spotlight'] }, start: num, duration: num, x: num, y: num, width: num, height: num },
      required: ['kind', 'start'],
    },
    run: ({ kind, start, duration, x, y, width, height }) => {
      const id = insert((p) => edit.addEffectClip(p, kind as EffectKind, { start: Number(start) }));
      if (id) {
        s().mutate((p) => {
          const clip = edit.getClip(p, id)!;
          return edit.updateClip(p, id, {
            duration: Number(duration ?? clip.duration),
            x: Number(x ?? 0),
            y: Number(y ?? 0),
            effect: { ...clip.effect!, width: Number(width ?? clip.effect!.width), height: Number(height ?? clip.effect!.height) },
          });
        });
      }
      return id;
    },
  },
  {
    id: 'clip.delete',
    title: 'Delete clips by id',
    description: 'Delete the given clips, optionally closing the gaps.',
    params: { type: 'object', properties: { clipIds: { type: 'array', items: str }, ripple: { type: 'boolean' } }, required: ['clipIds'] },
    run: ({ clipIds, ripple }) => s().commit((p) => edit.deleteClips(p, clipIds as string[], !!ripple)),
  },
  {
    id: 'project.update',
    title: 'Update project settings',
    description: 'Change project name, width, height, fps or background colour.',
    params: { type: 'object', properties: { name: str, width: num, height: num, fps: num, background: str } },
    run: (patch) => s().commit((p) => ({ ...p, ...(patch as Partial<Project>) })),
  },

  // Transcript-powered tools. Usable from the palette, and the assistant's main levers.
  {
    id: 'timeline.transcribe',
    title: 'Transcribe speech',
    description: 'Transcribe the speech on the timeline (runs on this device).',
    run: async () => ({ message: `Transcribed ${(await smart.ensureWords()).length} words` }),
  },
  {
    id: 'timeline.addCaptions',
    title: 'Add captions',
    description: 'Generate captions from the speech on the timeline, replacing any existing captions. Transcribes first if needed.',
    params: { type: 'object', properties: { maxChars: { type: 'number', description: 'Longest caption line in characters (default 34).' } } },
    run: ({ maxChars }) => smart.addCaptions(maxChars === undefined ? undefined : Number(maxChars)),
  },
  {
    id: 'captions.style',
    title: 'Style all captions',
    description: 'Restyle every caption at once. y is the vertical offset from the canvas centre in pixels (positive = lower).',
    params: {
      type: 'object',
      properties: { y: num, fontSize: num, color: str, background: { type: 'string', description: 'Box colour, or "" for none.' }, outline: str, outlineWidth: num, bold: { type: 'boolean' }, italic: { type: 'boolean' }, fontFamily: str },
    },
    hidden: true,
    run: ({ y, ...text }) => s().commit((p) => edit.styleCaptions(p, { y: y === undefined ? undefined : Number(y), text })),
  },
  { id: 'captions.exportSrt', title: 'Export captions (SRT)', description: 'Download captions as a .srt file for YouTube, Vimeo and most players.', run: () => smart.exportCaptions('srt') },
  { id: 'captions.exportVtt', title: 'Export captions (WebVTT)', description: 'Download captions as a .vtt file for web video players.', run: () => smart.exportCaptions('vtt') },
  { id: 'captions.exportText', title: 'Export transcript (text)', description: 'Download what is said as a plain text file.', run: () => smart.exportCaptions('txt') },
  {
    id: 'captions.remove',
    title: 'Remove captions',
    description: 'Delete all generated captions.',
    run: () => s().commit((p) => edit.setCaptions(p, [])),
  },
  {
    id: 'timeline.removeSilences',
    title: 'Remove silences',
    description: 'Cut silent pauses out of the whole timeline and close the gaps on every track.',
    params: {
      type: 'object',
      properties: {
        minDuration: { type: 'number', description: 'Shortest pause to remove, seconds (default 0.6).' },
        thresholdDb: { type: 'number', description: 'Level counted as silence in dBFS (default -38; closer to 0 cuts more).' },
        padding: { type: 'number', description: 'Quiet kept either side of speech, seconds (default 0.12).' },
      },
    },
    run: (options) => smart.removeSilences(options as edit.SilenceOptions),
  },
  {
    id: 'timeline.findSilences',
    title: 'Find silences',
    description: 'List silent ranges on the timeline without changing anything.',
    params: { type: 'object', properties: { minDuration: num, thresholdDb: num, padding: num } },
    hidden: true,
    run: (options) => smart.silences(options as edit.SilenceOptions),
  },
  {
    id: 'timeline.cutRanges',
    title: 'Cut time ranges',
    description: 'Remove time ranges (seconds) from the whole timeline and close the gaps, keeping all tracks in sync. Times refer to the timeline before this call; pass every range in one call.',
    params: {
      type: 'object',
      properties: { ranges: { type: 'array', items: { type: 'object', properties: { start: num, end: num }, required: ['start', 'end'] } } },
      required: ['ranges'],
    },
    run: ({ ranges }) => s().commit((p) => edit.rippleCut(p, ranges as { start: number; end: number }[])),
  },
  {
    id: 'timeline.getTranscript',
    title: 'Get transcript',
    description: 'Read what is said on the timeline as timed lines (timeline seconds). Transcribes first if needed, which can take a while. Set words=true for word-level timing within a short window.',
    params: { type: 'object', properties: { start: num, end: num, words: { type: 'boolean' } } },
    hidden: true,
    run: ({ start, end, words }) => smart.transcript(start === undefined ? 0 : Number(start), end === undefined ? Infinity : Number(end), !!words),
  },
  {
    id: 'project.get',
    title: 'Get project state',
    description: 'Return the current project: settings, tracks (top layer first), media library and clips.',
    params: { type: 'object', properties: {} },
    hidden: true,
    run: () => smart.snapshot(),
  },
  {
    id: 'view.frame',
    title: 'View frame',
    description: 'Look at the composited video frame at a timeline time. Use it to find where things are on screen before placing zooms, blurs, spotlights or callouts.',
    params: { type: 'object', properties: { time: num }, required: ['time'] },
    hidden: true,
    run: async ({ time }) => ({ image: await smart.frameJpeg(Number(time)) }),
  },
  { id: 'view.assistant', title: 'Open AI assistant', description: 'Show the assistant panel.', shortcut: 'A', run: () => s().setPanel('assistant') },
  { id: 'view.settings', title: 'Settings', description: 'API key, AI model and transcription settings.', run: () => s().setDialog('settings') },
];

const byId = new Map(commands.map((c) => [c.id, c]));

export function runCommand(id: string, params: Params = {}) {
  const command = byId.get(id);
  if (!command) throw new Error(`Unknown command: ${id}`);
  for (const key of command.params?.required ?? []) {
    if (params[key] === undefined) throw new Error(`${id}: missing required parameter "${key}"`);
  }
  return command.run(params);
}

export const paletteCommands = () => commands.filter((c) => !c.hidden && !c.params?.required?.length && c.id !== 'view.palette' && c.id !== 'project.update');

/** Run a command from the UI: surfaces its result message, and any failure, as a toast. */
export function invokeCommand(id: string, params: Params = {}) {
  Promise.resolve()
    .then(() => runCommand(id, params))
    .then((result) => {
      const message = (result as { message?: unknown } | undefined)?.message;
      if (typeof message === 'string') s().toast(message);
    })
    .catch((err) => s().toast(err instanceof Error ? err.message : String(err), 'error'));
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function shortcutLabel(shortcut: string): string {
  return shortcut
    .split('+')
    .map((k) => {
      if (k === 'Mod') return isMac ? '⌘' : 'Ctrl';
      if (k === 'Shift') return isMac ? '⇧' : 'Shift';
      if (k === 'ArrowRight') return '→';
      if (k === 'ArrowLeft') return '←';
      if (k === 'Delete') return 'Del';
      if (k === 'Escape') return 'Esc';
      return k;
    })
    .join(isMac ? '' : '+');
}

function comboOf(e: KeyboardEvent): string[] {
  const mod = e.metaKey || e.ctrlKey ? 'Mod+' : '';
  let key = e.code === 'Space' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (key === 'Backspace') key = 'Delete';
  if (key === '+') key = '=';
  if (key === '_') key = '-';
  const withShift = `${mod}${e.shiftKey ? 'Shift+' : ''}${key}`;
  // Symbols typed with shift (like "?") should also match without the modifier.
  return e.shiftKey && !/^[A-Z]$/.test(key) && key.length === 1 ? [withShift, `${mod}${key}`] : [withShift];
}

const byShortcut = new Map(commands.filter((c) => c.shortcut).map((c) => [c.shortcut!, c]));

/** Returns true if a command handled the key. */
export function handleShortcut(e: KeyboardEvent): boolean {
  if (e.altKey) return false;
  if (e.key === 'y' && (e.metaKey || e.ctrlKey)) {
    s().redo();
    return true;
  }
  for (const combo of comboOf(e)) {
    const command = byShortcut.get(combo);
    if (command) {
      invokeCommand(command.id);
      return true;
    }
  }
  return false;
}

/** Programmatic API for scripts, tests and (later) AI agents. */
export const api = {
  getProject: () => s().project,
  getState: () => ({ playhead: s().playhead, selection: s().selection, playing: s().playing }),
  listCommands: () => commands.map(({ id, title, description, params }) => ({ id, title, description, params })),
  run: runCommand,
};
