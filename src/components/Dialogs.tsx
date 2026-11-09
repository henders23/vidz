import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Mic, Monitor, X } from 'lucide-react';
import { useStore } from '../store';
import { commands, invokeCommand, paletteCommands, shortcutLabel } from '../lib/commands';
import { ExportOptions, ExportResult, exportProject, supportsExport } from '../lib/export';
import { projectDuration } from '../lib/edit';
import { useRecorder } from '../lib/recorder';
import { CLAUDE_MODELS, WHISPER_MODELS, useSettings } from '../lib/settings';
import { downloadBlob, formatBytes, formatDuration } from '../lib/util';

function Modal({ title, onClose, children, className = '' }: { title?: string; onClose: () => void; children: React.ReactNode; className?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={title}>
        {title && (
          <div className="modal-head">
            <h2>{title}</h2>
            <button className="icon-btn" aria-label="Close" onClick={onClose}><X size={16} /></button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

function ExportDialog({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project);
  const duration = projectDuration(project);
  const [options, setOptions] = useState<ExportOptions>({ height: project.height, fps: project.fps, format: 'mp4', quality: 'high' });
  const [progress, setProgress] = useState<{ fraction: number; stage: string } | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState('');
  const abort = useRef<AbortController | null>(null);
  const filename = (r: ExportResult) => `${project.name.trim() || 'vidz-export'}.${r.extension}`;
  const heights = [...new Set([project.height, 2160, 1440, 1080, 720, 480])].filter((h) => h <= Math.max(project.height, 1080)).sort((a, b) => b - a);
  const widthFor = (h: number) => Math.round(((project.width / project.height) * h) / 2) * 2;

  const run = async () => {
    setError('');
    setResult(null);
    setProgress({ fraction: 0, stage: 'Preparing' });
    abort.current = new AbortController();
    try {
      const { project: p, runtime } = useStore.getState();
      const res = await exportProject(p, runtime, options, (fraction, stage) => setProgress({ fraction, stage }), abort.current.signal);
      setResult(res);
      downloadBlob(res.blob, filename(res));
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProgress(null);
    }
  };

  const close = () => {
    abort.current?.abort();
    onClose();
  };

  const body = () => {
    if (!supportsExport()) return <p className="modal-note error">This browser can't encode video. Please use a recent version of Chrome, Edge or Safari.</p>;
    if (duration <= 0) return <p className="modal-note">Your timeline is empty. Add a clip first, then export.</p>;
    if (progress) {
      return (
        <div className="export-progress">
          <div className="bar"><div style={{ width: `${progress.fraction * 100}%` }} /></div>
          <p>{progress.stage}… {Math.round(progress.fraction * 100)}%</p>
          <p className="modal-note">Keep this tab open while your video renders.</p>
          <div className="modal-actions"><button className="btn" onClick={() => abort.current?.abort()}>Cancel</button></div>
        </div>
      );
    }
    if (result) {
      return (
        <div className="export-progress">
          <p className="done">Your video is ready — {formatBytes(result.blob.size)}</p>
          {result.notes.map((n) => <p key={n} className="modal-note">{n}</p>)}
          <div className="modal-actions">
            <button className="btn" onClick={() => setResult(null)}>Export again</button>
            <button className="btn primary" onClick={() => downloadBlob(result.blob, filename(result))}>Download again</button>
          </div>
        </div>
      );
    }
    return (
      <>
        <div className="form-grid">
          <label>Resolution
            <select value={options.height} onChange={(e) => setOptions({ ...options, height: Number(e.target.value) })}>
              {heights.map((h) => <option key={h} value={h}>{widthFor(h)} × {h}{h === project.height ? ' (project)' : ''}</option>)}
            </select>
          </label>
          <label>Frame rate
            <select value={options.fps} onChange={(e) => setOptions({ ...options, fps: Number(e.target.value) })}>
              {[...new Set([project.fps, 24, 30, 60])].sort((a, b) => a - b).map((f) => <option key={f} value={f}>{f} fps</option>)}
            </select>
          </label>
          <label>Format
            <select value={options.format} onChange={(e) => setOptions({ ...options, format: e.target.value as ExportOptions['format'] })}>
              <option value="mp4">MP4 (best compatibility)</option>
              <option value="webm">WebM</option>
            </select>
          </label>
          <label>Quality
            <select value={options.quality} onChange={(e) => setOptions({ ...options, quality: e.target.value as ExportOptions['quality'] })}>
              <option value="medium">Good (smaller file)</option>
              <option value="high">High</option>
              <option value="very-high">Best (larger file)</option>
            </select>
          </label>
        </div>
        {error && <p className="modal-note error">{error}</p>}
        <div className="modal-actions">
          <span className="modal-note">Length {formatDuration(duration)}</span>
          <span className="grow" />
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn primary" onClick={() => void run()}>Export video</button>
        </div>
      </>
    );
  };

  return <Modal title="Export video" onClose={close}>{body()}</Modal>;
}

function CommandPalette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return paletteCommands().filter((c) => !q || `${c.title} ${c.description}`.toLowerCase().includes(q));
  }, [query]);
  const run = (i: number) => {
    const command = items[i];
    if (!command) return;
    onClose();
    invokeCommand(command.id);
  };
  return (
    <Modal onClose={onClose} className="palette">
      <input
        autoFocus
        placeholder="Search actions…"
        aria-label="Search actions"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setIndex(0); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(items.length - 1, i + 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
          if (e.key === 'Enter') run(index);
        }}
      />
      <ul role="listbox">
        {items.map((c, i) => (
          <li key={c.id} role="option" aria-selected={i === index} className={i === index ? 'active' : ''} onPointerEnter={() => setIndex(i)} onClick={() => run(i)}
            ref={(el) => { if (el && i === index) el.scrollIntoView({ block: 'nearest' }); }}>
            <span>{c.title}<small>{c.description}</small></span>
            {c.shortcut && <kbd>{shortcutLabel(c.shortcut)}</kbd>}
          </li>
        ))}
        {items.length === 0 && <li className="none">No matching actions</li>}
      </ul>
    </Modal>
  );
}

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} className="shortcuts">
      <ul>
        {commands.filter((c) => c.shortcut).map((c) => (
          <li key={c.id}><span>{c.title}</span><kbd>{shortcutLabel(c.shortcut!)}</kbd></li>
        ))}
        <li><span>Zoom timeline</span><kbd>{shortcutLabel('Mod')} + scroll</kbd></li>
        <li><span>Disable snapping while dragging</span><kbd>Alt</kbd></li>
      </ul>
    </Modal>
  );
}

function RecordDialog({ onClose }: { onClose: () => void }) {
  const start = useRecorder((s) => s.start);
  const [options, setOptions] = useState({ screen: true, camera: false, microphone: true });
  const toggle = (key: keyof typeof options) => setOptions((o) => ({ ...o, [key]: !o[key] }));
  const sources = [
    { key: 'screen' as const, label: 'Screen', hint: 'A window, tab or your whole display', Icon: Monitor },
    { key: 'camera' as const, label: 'Camera', hint: 'Added as a picture-in-picture', Icon: Camera },
    { key: 'microphone' as const, label: 'Microphone', hint: 'Your voice-over', Icon: Mic },
  ];
  return (
    <Modal title="New recording" onClose={onClose}>
      <div className="record-sources">
        {sources.map(({ key, label, hint, Icon }) => (
          <button key={key} className={`record-source ${options[key] ? 'on' : ''}`} aria-pressed={options[key]} onClick={() => toggle(key)}>
            <Icon size={22} />
            <strong>{label}</strong>
            <small>{hint}</small>
          </button>
        ))}
      </div>
      <p className="modal-note">Your browser will ask what to share. When you stop, the recording lands on your timeline at the playhead.</p>
      <div className="modal-actions">
        <span className="grow" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          disabled={!options.screen && !options.camera && !options.microphone}
          onClick={() => { onClose(); void start(options); }}
        >
          Start recording
        </button>
      </div>
    </Modal>
  );
}

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useSettings();
  const [show, setShow] = useState(false);
  return (
    <Modal title="Settings" onClose={onClose}>
      <div className="settings">
        <label>Anthropic API key
          <span className="key-row">
            <input
              type={show ? 'text' : 'password'}
              value={settings.apiKey}
              placeholder="sk-ant-…"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => settings.update({ apiKey: e.target.value.trim() })}
            />
            <button className="btn small" type="button" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</button>
          </span>
          <small>Used by the assistant. It is stored only in this browser and sent only to Anthropic. Create one at console.anthropic.com; usage is billed to your Anthropic account.</small>
        </label>
        <label>Assistant model
          <select value={settings.model} onChange={(e) => settings.update({ model: e.target.value })}>
            {CLAUDE_MODELS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
        <label>Transcription quality
          <select value={settings.whisperModel} onChange={(e) => settings.update({ whisperModel: e.target.value })}>
            {WHISPER_MODELS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
          <small>Speech is transcribed on this device; audio is never uploaded. The model downloads once and is then cached.</small>
        </label>
        <label>Spoken language
          <input value={settings.language} placeholder="en" onChange={(e) => settings.update({ language: e.target.value.trim().toLowerCase() })} />
          <small>A language code such as en, es, de, fr or ja. Applies to new transcriptions.</small>
        </label>
      </div>
      <div className="modal-actions"><button className="btn primary" onClick={onClose}>Done</button></div>
    </Modal>
  );
}

export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  const setDialog = useStore((s) => s.setDialog);
  const close = () => setDialog(null);
  if (dialog === 'export') return <ExportDialog onClose={close} />;
  if (dialog === 'palette') return <CommandPalette onClose={close} />;
  if (dialog === 'shortcuts') return <ShortcutsDialog onClose={close} />;
  if (dialog === 'record') return <RecordDialog onClose={close} />;
  if (dialog === 'settings') return <SettingsDialog onClose={close} />;
  return null;
}
