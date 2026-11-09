/**
 * Command registry. Every user-facing action is a named command with a
 * description and (optionally) a JSON-schema for its parameters. The keyboard
 * shortcuts, the command palette and `window.vidz` all go through here, which
 * is also the surface an AI agent will use to edit a project.
 */
import { Clip, Project, ShapeKind, clipEnd } from '../types';
import { useStore } from '../store';
import * as edit from './edit';
import { kindOf } from './media';

type Params = Record<string, unknown>;

export interface Command {
  id: string;
  title: string;
  description: string;
  shortcut?: string;
  /** JSON schema of the parameters. Commands without required params appear in the palette. */
  params?: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
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
    description: 'Patch any clip properties (x, y, scale, rotation, opacity, volume, fadeIn, fadeOut, filters, text, shape).',
    params: { type: 'object', properties: { clipId: str, patch: { type: 'object' } }, required: ['clipId', 'patch'] },
    run: ({ clipId, patch }) => s().commit((p) => edit.updateClip(p, String(clipId), patch as Partial<Clip>)),
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

export const paletteCommands = () => commands.filter((c) => !c.params?.required?.length && c.id !== 'view.palette' && c.id !== 'project.update');

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
      command.run({});
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
