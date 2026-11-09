import { create } from 'zustand';
import { get as idbGet, set as idbSet } from 'idb-keyval';
import { Project, hasSound } from './types';
import { TranscribeProgress, transcribe } from './lib/transcribe';
import * as edit from './lib/edit';
import { MediaRuntime, deleteMediaData, importFile, loadMediaRuntime } from './lib/media';
import { clamp } from './lib/util';

const PROJECT_KEY = 'vidz:project';
const HISTORY_LIMIT = 200;

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error';
}

interface State {
  ready: boolean;
  project: Project;
  runtime: Record<string, MediaRuntime>;
  selection: string[];
  playhead: number;
  playing: boolean;
  pxPerSec: number;
  past: Project[];
  future: Project[];
  importing: number;
  dialog: null | 'export' | 'palette' | 'record' | 'shortcuts' | 'settings';
  panel: 'properties' | 'assistant' | 'transcript';
  /** Progress of the running transcription, if any. */
  transcribing: null | { name: string; stage: TranscribeProgress['stage']; progress?: number };
  toasts: Toast[];

  /** Apply an edit as a single undo step. */
  commit: (fn: (p: Project) => Project) => void;
  /** Apply an edit without recording history (use after `checkpoint` during drags). */
  mutate: (fn: (p: Project) => Project) => void;
  checkpoint: () => void;
  undo: () => void;
  redo: () => void;
  select: (ids: string[]) => void;
  toggleSelect: (id: string) => void;
  setPlayhead: (t: number) => void;
  setPlaying: (playing: boolean) => void;
  setZoom: (pxPerSec: number) => void;
  setDialog: (d: State['dialog']) => void;
  setPanel: (p: State['panel']) => void;
  /** Transcribe every clip on the timeline that has speech and no transcript yet. Returns false if nothing could be transcribed. */
  ensureTranscripts: () => Promise<boolean>;
  toast: (message: string, kind?: Toast['kind']) => void;
  importFiles: (files: Iterable<File>) => Promise<string[]>;
  deleteMedia: (id: string) => void;
  newProject: () => Promise<void>;
  load: () => Promise<void>;
}

let toastId = 0;

export const useStore = create<State>((set, get) => ({
  ready: false,
  project: edit.createProject(),
  runtime: {},
  selection: [],
  playhead: 0,
  playing: false,
  pxPerSec: 80,
  past: [],
  future: [],
  importing: 0,
  dialog: null,
  panel: 'properties',
  transcribing: null,
  toasts: [],

  commit: (fn) => {
    const { project, past } = get();
    const next = fn(project);
    if (next === project) return;
    set({ project: next, past: [...past.slice(-HISTORY_LIMIT), project], future: [] });
  },
  mutate: (fn) => set({ project: fn(get().project) }),
  checkpoint: () => set((s) => ({ past: [...s.past.slice(-HISTORY_LIMIT), s.project], future: [] })),
  undo: () => {
    const { past, future, project } = get();
    if (!past.length) return;
    const previous = past[past.length - 1];
    set({ project: keepMedia(previous, project), past: past.slice(0, -1), future: [project, ...future] });
    pruneSelection();
  },
  redo: () => {
    const { past, future, project } = get();
    if (!future.length) return;
    set({ project: keepMedia(future[0], project), past: [...past, project], future: future.slice(1) });
    pruneSelection();
  },
  select: (ids) => set({ selection: ids }),
  toggleSelect: (id) =>
    set((s) => ({ selection: s.selection.includes(id) ? s.selection.filter((x) => x !== id) : [...s.selection, id] })),
  setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
  setPlaying: (playing) => {
    const { project, playhead } = get();
    const duration = edit.projectDuration(project);
    if (playing && duration === 0) return;
    // Pressing play at the very end restarts from the top.
    set({ playing, playhead: playing && playhead >= duration - 0.01 ? 0 : playhead });
  },
  setZoom: (pxPerSec) => set({ pxPerSec: clamp(pxPerSec, 4, 600) }),
  setDialog: (dialog) => set({ dialog, playing: false }),
  setPanel: (panel) => set({ panel }),
  ensureTranscripts: async () => {
    if (get().transcribing) throw new Error('A transcription is already running');
    const { project } = get();
    const ids = [...new Set(project.clips.filter((c) => hasSound(c) && c.mediaId).map((c) => c.mediaId!))].filter(
      (id) => edit.getMedia(project, id)?.hasAudio,
    );
    try {
      for (const id of ids) {
        const rt = get().runtime[id];
        if (!rt || rt.transcript) continue;
        const name = edit.getMedia(project, id)?.name ?? 'media';
        const transcript = await transcribe(id, rt.blob, (p) => set({ transcribing: { name, ...p } }));
        set((s) => (s.runtime[id] ? { runtime: { ...s.runtime, [id]: { ...s.runtime[id], transcript } } } : {}));
      }
    } finally {
      set({ transcribing: null });
    }
    return ids.some((id) => get().runtime[id]?.transcript);
  },
  toast: (message, kind = 'info') => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 6000 : 3000);
  },

  importFiles: async (files) => {
    const ids: string[] = [];
    for (const file of files) {
      set((s) => ({ importing: s.importing + 1 }));
      try {
        const { asset, runtime } = await importFile(file);
        // Media is not part of undo history: an import should survive an undo.
        set((s) => ({ project: edit.addMedia(s.project, asset), runtime: { ...s.runtime, [asset.id]: runtime } }));
        ids.push(asset.id);
      } catch (err) {
        get().toast(err instanceof Error ? err.message : `Could not import ${file.name}`, 'error');
      } finally {
        set((s) => ({ importing: s.importing - 1 }));
      }
    }
    return ids;
  },

  deleteMedia: (id) => {
    const strip = (p: Project) => edit.removeMedia(p, id);
    set((s) => ({
      project: strip(s.project),
      // The bytes are gone, so history can no longer reference this asset.
      past: s.past.map(strip),
      future: s.future.map(strip),
      runtime: Object.fromEntries(Object.entries(s.runtime).filter(([k]) => k !== id)),
    }));
    pruneSelection();
    void deleteMediaData(id);
  },

  newProject: async () => {
    const old = get().project;
    await Promise.all(old.media.map((m) => deleteMediaData(m.id)));
    set({ project: edit.createProject(), runtime: {}, selection: [], playhead: 0, playing: false, past: [], future: [] });
  },

  load: async () => {
    try {
      const saved = await idbGet<Project>(PROJECT_KEY);
      if (saved?.tracks?.length) {
        const runtime: Record<string, MediaRuntime> = {};
        for (const m of saved.media) {
          const r = await loadMediaRuntime(m.id);
          if (r) runtime[m.id] = r;
        }
        const missing = saved.media.filter((m) => !runtime[m.id]);
        const project = missing.reduce((p, m) => edit.removeMedia(p, m.id), saved);
        set({ project, runtime });
      }
    } catch (err) {
      console.error('Failed to load saved project', err);
    }
    set({ ready: true });
  },
}));

/** Undo/redo restores edits but never drops media imported since that snapshot. */
function keepMedia(target: Project, current: Project): Project {
  return target.media === current.media ? target : { ...target, media: current.media };
}

function pruneSelection() {
  const { project, selection } = useStore.getState();
  const alive = selection.filter((id) => project.clips.some((c) => c.id === id));
  if (alive.length !== selection.length) useStore.setState({ selection: alive });
}

// Autosave: persist the project shortly after any change.
let saveTimer: ReturnType<typeof setTimeout> | undefined;
useStore.subscribe((state, prev) => {
  if (!state.ready || state.project === prev.project) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    idbSet(PROJECT_KEY, useStore.getState().project).catch((err) => console.error('Autosave failed', err));
  }, 400);
});

export const getState = useStore.getState;

// Continuous edits (typing, sliders): call `armHistory` when the interaction
// starts and `liveEdit` for each change, so the whole gesture is one undo step.
let armed = false;
export const armHistory = () => {
  armed = true;
};
export function liveEdit(fn: (p: Project) => Project) {
  const s = useStore.getState();
  if (armed) {
    armed = false;
    s.checkpoint();
  }
  s.mutate(fn);
}
