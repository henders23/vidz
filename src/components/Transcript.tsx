import { useMemo, useRef, useState } from 'react';
import { Captions, Download, Scissors, Users } from 'lucide-react';
import { useStore } from '../store';
import * as edit from '../lib/edit';
import { invokeCommand } from '../lib/commands';
import { TranscribeStatus } from './Assistant';

/** The words on the timeline: click to jump, select a passage and cut it out of the video. */
export function Transcript() {
  const project = useStore((s) => s.project);
  const runtime = useStore((s) => s.runtime);
  const busy = useStore((s) => !!s.transcribing);
  const words = useMemo(() => edit.timelineWords(project, (id) => runtime[id]?.transcript), [project, runtime]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<{ from: number; to: number } | null>(null);
  // Re-render only when the playhead moves onto a different word.
  const current = useStore((s) => {
    let lo = 0;
    let hi = words.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (words[mid].end <= s.playhead) lo = mid + 1;
      else hi = mid - 1;
    }
    return lo < words.length && words[lo].start <= s.playhead + 0.05 ? lo : -1;
  });

  const hasSpeechClips = project.clips.some((c) => (c.type === 'video' || c.type === 'audio') && edit.getMedia(project, c.mediaId)?.hasAudio);
  const untranscribed = project.clips.some((c) => (c.type === 'video' || c.type === 'audio') && c.mediaId && edit.getMedia(project, c.mediaId)?.hasAudio && !runtime[c.mediaId]?.transcript);

  const readSelection = () => {
    const sel = window.getSelection();
    const body = bodyRef.current;
    if (!sel || sel.isCollapsed || !body || !sel.rangeCount) return setPicked(null);
    const range = sel.getRangeAt(0);
    const indexes = [...body.querySelectorAll<HTMLElement>('[data-i]')].filter((el) => range.intersectsNode(el)).map((el) => Number(el.dataset.i));
    setPicked(indexes.length ? { from: Math.min(...indexes), to: Math.max(...indexes) } : null);
  };

  const cut = () => {
    if (!picked) return;
    const range = { start: words[picked.from].start, end: words[picked.to].end };
    useStore.getState().commit((p) => edit.rippleCut(p, [range]));
    useStore.getState().setPlayhead(range.start);
    window.getSelection()?.removeAllRanges();
    setPicked(null);
  };

  // Start a new paragraph at each longer pause or change of speaker.
  const names = useMemo(() => edit.speakerLabels(project, words), [project, words]);
  const paragraphs: number[][] = [];
  words.forEach((w, i) => {
    if (i === 0 || w.start - words[i - 1].end > 1.2 || w.speakerKey !== words[i - 1].speakerKey) paragraphs.push([]);
    paragraphs[paragraphs.length - 1].push(i);
  });
  // Which speaker label is being renamed, by the index of the first word of its paragraph
  // (a speaker has a label on each of their turns; only the clicked one becomes a text box).
  const [renaming, setRenaming] = useState<number | null>(null);
  const rename = (key: string, name: string) => {
    setRenaming(null);
    if (name.trim() === names.get(key)) return;
    useStore.getState().commit((p) => ({ ...p, speakerNames: { ...p.speakerNames, [key]: name.trim() } }));
  };

  return (
    <div className="transcript">
      <div className="quick-actions">
        {(untranscribed || !words.length) && (
          <button className="btn small primary" disabled={busy || !hasSpeechClips} onClick={() => invokeCommand('timeline.transcribe')}>
            Transcribe
          </button>
        )}
        <button className="btn small" disabled={busy || !words.length} onClick={() => invokeCommand('timeline.addCaptions')}><Captions size={13} /> Captions</button>
        <button className="btn small" disabled={!picked} title="Cut the selected words out of the video" onClick={cut}><Scissors size={13} /> Cut selection</button>
        <button className="btn small" disabled={busy || !words.length} title="Work out who is speaking. Runs on your device; the first run downloads a small voice model." onClick={() => invokeCommand('timeline.labelSpeakers')}><Users size={13} /> Speakers</button>
      </div>
      {words.length > 0 && (
        <div className="quick-actions export-row">
          <span><Download size={13} /> Save as</span>
          <button className="btn small" title="Captions file for YouTube, Vimeo and most players" onClick={() => invokeCommand('captions.exportSrt')}>SRT</button>
          <button className="btn small" title="Captions file for web video players" onClick={() => invokeCommand('captions.exportVtt')}>VTT</button>
          <button className="btn small" title="Plain text transcript" onClick={() => invokeCommand('captions.exportText')}>Text</button>
        </div>
      )}
      <TranscribeStatus />
      {words.length === 0 ? (
        <p className="insp-hint">
          {hasSpeechClips
            ? 'Transcribe to see what is said in your video. It runs on your device: nothing is uploaded. The first run downloads a speech model.'
            : 'Add a video or audio clip with speech to the timeline, then transcribe it here.'}
        </p>
      ) : (
        <div className="transcript-body" ref={bodyRef} onMouseUp={readSelection} onKeyUp={readSelection}>
          {paragraphs.map((indexes) => {
            const key = words[indexes[0]].speakerKey;
            const newTurn = key && (indexes[0] === 0 || words[indexes[0] - 1].speakerKey !== key);
            return (
            <p key={indexes[0]}>
              {newTurn && key && (renaming === indexes[0] ? (
                <input
                  className="speaker-input"
                  autoFocus
                  defaultValue={names.get(key)}
                  aria-label="Speaker name"
                  onBlur={(e) => rename(key, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
                <button className={`speaker speaker-${([...names.keys()].indexOf(key) % 6) + 1}`} title="Click to rename this speaker" onClick={() => setRenaming(indexes[0])}>
                  {names.get(key)}
                </button>
              ))}
              {indexes.map((i) => (
                <span
                  key={i}
                  data-i={i}
                  className={`word ${i === current ? 'now' : ''} ${picked && i >= picked.from && i <= picked.to ? 'picked' : ''}`}
                  onClick={() => window.getSelection()?.isCollapsed && useStore.getState().setPlayhead(words[i].start)}
                >
                  {words[i].text}{' '}
                </span>
              ))}
            </p>
            );
          })}
          <p className="insp-hint">Click a word to jump there. Select words and choose Cut selection to remove them from the video.</p>
        </div>
      )}
    </div>
  );
}
