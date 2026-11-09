import { useEffect, useState } from 'react';
import { Check, Download, FilePlus2, Keyboard, Search, Settings, Sparkles, Square, Video } from 'lucide-react';
import { armHistory, liveEdit, useStore } from '../store';
import { runCommand, shortcutLabel } from '../lib/commands';
import { canRecordScreen, useRecorder } from '../lib/recorder';
import { formatDuration } from '../lib/util';

function RecordButton() {
  const status = useRecorder((s) => s.status);
  const startedAt = useRecorder((s) => s.startedAt);
  const stop = useRecorder((s) => s.stop);
  const [, tick] = useState(0);
  useEffect(() => {
    if (status !== 'recording') return;
    const timer = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(timer);
  }, [status]);
  if (status === 'recording') {
    return (
      <button className="btn recording" onClick={stop}>
        <Square size={12} fill="currentColor" /> Stop · {formatDuration((Date.now() - startedAt) / 1000)}
      </button>
    );
  }
  if (status === 'processing') return <button className="btn" disabled><span className="spinner" /> Saving…</button>;
  if (!canRecordScreen()) return null;
  return (
    <button className="btn" title="Record screen, camera or microphone (R)" onClick={() => runCommand('file.record')}>
      <Video size={15} /> Record
    </button>
  );
}

export function TopBar() {
  const name = useStore((s) => s.project.name);
  const newProject = useStore((s) => s.newProject);
  const hasContent = useStore((s) => s.project.clips.length > 0 || s.project.media.length > 0);
  return (
    <header className="topbar">
      <div className="logo"><span className="logo-mark">▶</span>vidz</div>
      <input
        className="project-name"
        value={name}
        aria-label="Project name"
        spellCheck={false}
        onFocus={armHistory}
        onChange={(e) => liveEdit((p) => ({ ...p, name: e.target.value }))}
      />
      <span className="saved" title="Your project and media are saved automatically in this browser"><Check size={13} /> Saved on this device</span>
      <span className="grow" />
      <button className="search-btn" onClick={() => runCommand('view.palette')}>
        <Search size={14} /> Search actions <kbd>{shortcutLabel('Mod+K')}</kbd>
      </button>
      <button className="btn" title="Open the AI assistant (A)" onClick={() => runCommand('view.assistant')}><Sparkles size={15} /> Assistant</button>
      <button className="icon-btn" title="Settings" aria-label="Settings" onClick={() => runCommand('view.settings')}><Settings size={17} /></button>
      <button className="icon-btn" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" onClick={() => runCommand('view.shortcuts')}><Keyboard size={17} /></button>
      <button
        className="icon-btn"
        title="New project"
        aria-label="New project"
        onClick={() => {
          if (!hasContent || confirm('Start a new project? The current project and its media will be removed from this browser.')) void newProject();
        }}
      >
        <FilePlus2 size={17} />
      </button>
      <RecordButton />
      <button className="btn primary" onClick={() => runCommand('file.export')}><Download size={15} /> Export</button>
    </header>
  );
}
