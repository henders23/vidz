import { create } from 'zustand';
import { del as idbDel, get as idbGet, set as idbSet } from 'idb-keyval';
import { Project, hasSound } from './types';
import { TranscribeProgress, labelSpeakers, transcribe } from './lib/transcribe';
import * as edit from './lib/edit';
import { MediaRuntime, deleteMediaData, importFile, loadMediaRuntime } from './lib/media';
import { clamp } from './lib/util';

/** Where the single project lived before vidz supported several; migrated on first load. */
const LEGACY_KEY = 'vidz:project';
const INDEX_KEY = 'vidz:projects';
const CURRENT_KEY = 'vidz:current';
const projectKey = (id: string) => `vidz:project:${id}`;

/** What the project list needs to show a project without loading it. */
export interface ProjectInfo {
  id: string;
  name: string;
  updatedAt: number;
  /** Seconds. */
  duration: number;
  /** Total size of the project's media, bytes. */
  size: number;
  /** Small JPEG data URL. */
  thumbnail?: string;
}

const describe = (project: Project, previous?: ProjectInfo): ProjectInfo => ({
  id: project.id,
  name: project.name,
  updatedAt: Date.now(),
  duration: edit.projectDuration(project),
  size: project.media.reduce((n, m) => n + m.size, 0),
  thumbnail: previous?.thumbnail,
});
const HISTORY_LIMIT = 200;

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error';
}

interface State {
  ready: boolean;
  /** Every project saved in this browser, most recently edited first. */
  projects: ProjectInfo[];
  project: Project;
  runtime: Record<string, MediaRuntime>;
  selection: string[];
  playhead: number;
  playing: boolean;
  pxPerSec: number;
  past: Project[];
  future: Project[];
  importing: number;
  dialog: null | 'export' | 'palette' | 'record' | 'shortcuts' | 'settings' | 'projects';
  panel: 'properties' | 'assistant' | 'transcript';
  /** Progress of the running transcription, if any. */
  transcribing: null | { name: string; stage: TranscribeProgress['stage']; progress?: number };
  /** Progress (0..1) of a running motion track, if any. */
  tracking: null | number;
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
  /** Work out who is speaking in every transcribed clip on the timeline. Returns how many speakers were found. */
  labelSpeakers: () => Promise<number>;
  toast: (message: string, kind?: Toast['kind']) => void;
  importFiles: (files: Iterable<File>) => Promise<string[]>;
  deleteMedia: (id: string) => void;
  /** Start a new, empty project. The current one stays in the project list. */
  newProject: () => Promise<void>;
  openProject: (id: string) => Promise<void>;
  /** Permanently delete a project and its media from this browser. */
  deleteProject: (id: string) => Promise<void>;
  setThumbnail: (id: string, thumbnail: string) => void;
  load: () => Promise<void>;
}

let toastId = 0;

export const useStore = create<State>((set, get) => ({
  ready: false,
  projects: [],
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
  tracking: null,
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

  labelSpeakers: async () => {
    if (get().transcribing) throw new Error('A transcription is already running');
    const { project } = get();
    const ids = [...new Set(project.clips.filter((c) => hasSound(c) && c.mediaId).map((c) => c.mediaId!))];
    const keys = new Set<string>();
    try {
      for (const id of ids) {
        const rt = get().runtime[id];
        if (!rt?.transcript?.length) continue;
        const name = edit.getMedia(project, id)?.name ?? 'media';
        const transcript = await labelSpeakers(id, rt.blob, rt.transcript, (p) => set({ transcribing: { name, ...p } }));
        set((s) => (s.runtime[id] ? { runtime: { ...s.runtime, [id]: { ...s.runtime[id], transcript } } } : {}));
        for (const w of transcript) if (w.speaker !== undefined) keys.add(`${id}:${w.speaker}`);
      }
    } finally {
      set({ transcribing: null });
    }
    return keys.size;
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
    // Already on a blank project: nothing to do.
    if (!get().project.clips.length && !get().project.media.length) return;
    await flushSave();
    releaseMedia(get().runtime);
    const project = edit.createProject();
    set({ project, runtime: {}, selection: [], playhead: 0, playing: false, past: [], future: [] });
    await persist(project);
  },

  openProject: async (id) => {
    if (id === get().project.id) return;
    await flushSave();
    const saved = await idbGet<Project>(projectKey(id));
    if (!saved?.tracks?.length) {
      // The entry is stale (its data is gone): drop it from the list.
      await saveIndex(get().projects.filter((p) => p.id !== id));
      throw new Error('That project could not be found in this browser');
    }
    const { project, runtime } = await hydrate(saved);
    releaseMedia(get().runtime);
    set({ project, runtime, selection: [], playhead: 0, playing: false, past: [], future: [] });
    remember(id);
  },

  deleteProject: async (id) => {
    const current = get().project.id === id;
    const saved = current ? get().project : await idbGet<Project>(projectKey(id));
    if (current) {
      clearTimeout(saveTimer);
      // Move to another project (or a fresh one) before removing this one.
      const next = get().projects.find((p) => p.id !== id);
      releaseMedia(get().runtime);
      const replacement = next ? await idbGet<Project>(projectKey(next.id)) : undefined;
      const opened = replacement?.tracks?.length ? await hydrate(replacement) : { project: edit.createProject(), runtime: {} };
      set({ ...opened, selection: [], playhead: 0, playing: false, past: [], future: [] });
      remember(opened.project.id);
      if (!replacement) await persist(opened.project);
    }
    await Promise.all((saved?.media ?? []).map((m) => deleteMediaData(m.id)));
    await idbDel(projectKey(id));
    await saveIndex(get().projects.filter((p) => p.id !== id));
  },

  setThumbnail: (id, thumbnail) => {
    void saveIndex(get().projects.map((p) => (p.id === id ? { ...p, thumbnail } : p)));
  },

  load: async () => {
    try {
      let projects = (await idbGet<ProjectInfo[]>(INDEX_KEY)) ?? [];
      const legacy = await idbGet<Project>(LEGACY_KEY);
      if (legacy?.tracks?.length && !projects.some((p) => p.id === legacy.id)) {
        await idbSet(projectKey(legacy.id), legacy);
        projects = [describe(legacy), ...projects];
        await idbSet(INDEX_KEY, projects);
      }
      if (legacy) await idbDel(LEGACY_KEY);
      set({ projects });
      let wanted: string | null = null;
      try {
        wanted = localStorage.getItem(CURRENT_KEY);
      } catch {
        // Storage unavailable: fall back to the most recent project.
      }
      const id = projects.some((p) => p.id === wanted) ? wanted! : projects[0]?.id;
      const saved = id ? await idbGet<Project>(projectKey(id)) : undefined;
      if (saved?.tracks?.length) set(await hydrate(saved));
    } catch (err) {
      console.error('Failed to load saved project', err);
    }
    remember(get().project.id);
    set({ ready: true });
  },
}));

/** Load a saved project's media, dropping references to any whose data has gone missing. */
async function hydrate(saved: Project): Promise<{ project: Project; runtime: Record<string, MediaRuntime> }> {
  const runtime: Record<string, MediaRuntime> = {};
  for (const m of saved.media) {
    const r = await loadMediaRuntime(m.id);
    if (r) runtime[m.id] = r;
  }
  const missing = saved.media.filter((m) => !runtime[m.id]);
  return { project: missing.reduce((p, m) => edit.removeMedia(p, m.id), saved), runtime };
}

/** Free the object URLs held for a project that is being closed. */
function releaseMedia(runtime: Record<string, MediaRuntime>) {
  for (const r of Object.values(runtime)) {
    for (const url of [r.url, r.poster, r.filmstrip?.url]) if (url) URL.revokeObjectURL(url);
  }
}

function remember(id: string) {
  try {
    localStorage.setItem(CURRENT_KEY, id);
  } catch {
    // Storage unavailable: the most recently edited project opens next time instead.
  }
}

async function saveIndex(projects: ProjectInfo[]) {
  projects = [...projects].sort((a, b) => b.updatedAt - a.updatedAt);
  useStore.setState({ projects });
  await idbSet(INDEX_KEY, projects);
}

/** Write a project and refresh its entry in the project list. */
async function persist(project: Project) {
  await idbSet(projectKey(project.id), project);
  const { projects } = useStore.getState();
  const previous = projects.find((p) => p.id === project.id);
  await saveIndex([describe(project, previous), ...projects.filter((p) => p.id !== project.id)]);
  remember(project.id);
}

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
let dirty = false;
useStore.subscribe((state, prev) => {
  if (!state.ready || state.project === prev.project || state.project.id !== prev.project.id) return;
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushSave(), 400);
});

/** Save any pending edits now (before switching project, for example). */
async function flushSave() {
  clearTimeout(saveTimer);
  if (!dirty) return;
  dirty = false;
  await persist(useStore.getState().project).catch((err) => console.error('Autosave failed', err));
}

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
