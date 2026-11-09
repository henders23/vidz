import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Captions, Check, KeyRound, Loader2, RotateCcw, Scissors, Square, X } from 'lucide-react';
import { useStore } from '../store';
import { useAssistant } from '../lib/ai';
import { invokeCommand } from '../lib/commands';
import { useSettings } from '../lib/settings';

const SUGGESTIONS = [
  'Remove the silent pauses',
  'Add captions',
  'Zoom in on the most important part of the screen at the playhead',
  'Add a title at the start that says what this video is about',
  'Cut out any retakes or mistakes',
];

export function TranscribeStatus() {
  const t = useStore((s) => s.transcribing);
  if (!t) return null;
  const label =
    t.stage === 'download' ? `Downloading speech model… ${Math.round((t.progress ?? 0) * 100)}%`
    : t.stage === 'decode' ? `Reading audio from ${t.name}…`
    : `Transcribing ${t.name}… this runs on your device and can take a while`;
  return (
    <div className="transcribe-status" role="status">
      <Loader2 size={14} className="spin" /> <span>{label}</span>
    </div>
  );
}

export function Assistant() {
  const items = useAssistant((s) => s.items);
  const busy = useAssistant((s) => s.busy);
  const send = useAssistant((s) => s.send);
  const stop = useAssistant((s) => s.stop);
  const reset = useAssistant((s) => s.reset);
  const hasKey = useSettings((s) => !!s.apiKey);
  const setDialog = useStore((s) => s.setDialog);
  const hasClips = useStore((s) => s.project.clips.length > 0);
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [items]);

  const submit = (text = draft) => {
    if (!text.trim() || busy) return;
    setDraft('');
    void send(text);
  };

  return (
    <div className="assistant">
      <div className="quick-actions">
        <button className="btn small" disabled={!hasClips} onClick={() => invokeCommand('timeline.addCaptions')}><Captions size={13} /> Captions</button>
        <button className="btn small" disabled={!hasClips} onClick={() => invokeCommand('timeline.removeSilences')}><Scissors size={13} /> Remove silences</button>
        <span className="grow" />
        {items.length > 0 && (
          <button className="icon-btn" title="Start a new conversation" aria-label="Start a new conversation" onClick={reset}><RotateCcw size={14} /></button>
        )}
      </div>
      <TranscribeStatus />
      <div className="chat" ref={listRef}>
        {items.length === 0 && (
          <div className="chat-empty">
            <p>Tell the assistant what you want and it edits the timeline for you. Each request is one undo step.</p>
            {!hasKey && (
              <button className="btn primary" onClick={() => setDialog('settings')}><KeyRound size={14} /> Add your Anthropic API key</button>
            )}
            <div className="suggestions">
              {SUGGESTIONS.map((text) => (
                <button key={text} disabled={!hasKey || !hasClips || busy} onClick={() => submit(text)}>{text}</button>
              ))}
            </div>
            {hasKey && !hasClips && <p className="insp-hint">Add something to the timeline first.</p>}
          </div>
        )}
        {items.map((item) =>
          item.kind === 'tool' ? (
            <div key={item.id} className={`chat-tool ${item.status}`}>
              {item.status === 'running' ? <Loader2 size={12} className="spin" /> : item.status === 'failed' ? <X size={12} /> : <Check size={12} />}
              {item.text}
            </div>
          ) : (
            <div key={item.id} className={`chat-msg ${item.kind}`}>{item.text}</div>
          ),
        )}
        {busy && items[items.length - 1]?.kind === 'user' && <div className="chat-tool running"><Loader2 size={12} className="spin" /> Thinking…</div>}
      </div>
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          value={draft}
          rows={2}
          placeholder={hasKey ? 'Ask for an edit…' : 'Add an API key in Settings to chat'}
          aria-label="Message the assistant"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {busy ? (
          <button type="button" className="send stop" title="Stop" aria-label="Stop" onClick={stop}><Square size={12} fill="currentColor" /></button>
        ) : (
          <button type="submit" className="send" title="Send" aria-label="Send" disabled={!draft.trim()}><ArrowUp size={16} /></button>
        )}
      </form>
    </div>
  );
}
