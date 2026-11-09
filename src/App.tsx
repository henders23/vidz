import { useEffect, useState } from 'react';
import { useStore } from './store';
import { api, filesFromDrop, handleShortcut } from './lib/commands';
import { useRecorder } from './lib/recorder';
import { isTyping } from './lib/util';
import { TopBar } from './components/TopBar';
import { MediaBin } from './components/MediaBin';
import { Preview } from './components/Preview';
import { Inspector } from './components/Inspector';
import { Timeline } from './components/Timeline';
import { Dialogs } from './components/Dialogs';

declare global {
  interface Window {
    vidz: typeof api;
  }
}

export function App() {
  const ready = useStore((s) => s.ready);
  const toasts = useStore((s) => s.toasts);
  const [dropping, setDropping] = useState(false);

  useEffect(() => {
    window.vidz = api;
    void useStore.getState().load();

    const onKey = (e: KeyboardEvent) => {
      const { dialog } = useStore.getState();
      if (dialog) return;
      // Let text fields keep their own keys, except app-level Ctrl/Cmd shortcuts that don't clash with editing.
      if (isTyping(e)) {
        const appLevel = (e.metaKey || e.ctrlKey) && ['k', 'e', 'i'].includes(e.key.toLowerCase());
        if (e.key === 'Escape') (e.target as HTMLElement).blur();
        if (!appLevel) return;
      }
      if (handleShortcut(e)) e.preventDefault();
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (useRecorder.getState().status !== 'idle') e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, []);

  if (!ready) return <div className="boot"><span className="spinner" /> Loading your project…</div>;

  return (
    <div
      className="app"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => !e.relatedTarget && setDropping(false)}
      onDrop={(e) => {
        setDropping(false);
        const files = filesFromDrop(e);
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        if (files.length) void useStore.getState().importFiles(files);
        else useStore.getState().toast('Those files are not video, audio or images', 'error');
      }}
    >
      <TopBar />
      <main className="workspace">
        <MediaBin />
        <Preview />
        <Inspector />
      </main>
      <Timeline />
      <Dialogs />
      {dropping && <div className="drop-overlay">Drop to import</div>}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.message}</div>)}
      </div>
    </div>
  );
}
