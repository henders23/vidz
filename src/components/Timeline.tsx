import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight, Blend, Circle, Copy, Droplet, Focus, MousePointerClick, ZoomIn, Eye, EyeOff, Lock, LockOpen, Maximize2, Minus, Plus, Redo2, Scissors, Square, Trash2, Type,
  Undo2, Volume2, VolumeX, X,
} from 'lucide-react';
import { Clip, Track, canTransition, clipEnd } from '../types';
import { armHistory, liveEdit, useStore } from '../store';
import * as edit from '../lib/edit';
import { addMediaToTimeline, filesFromDrop, runCommand, shortcutLabel, commands } from '../lib/commands';
import { MediaRuntime, PEAKS_PER_SECOND } from '../lib/media';
import { formatTime, startDrag } from '../lib/util';

const HEADER_W = 148;
const RULER_H = 28;
const LANE_H = { video: 58, audio: 46 };
const SNAP_PX = 8;
export const MEDIA_DRAG_TYPE = 'application/x-vidz-media';

const TICK_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];

const shortcutOf = (id: string) => {
  const sc = commands.find((c) => c.id === id)?.shortcut;
  return sc ? ` (${shortcutLabel(sc)})` : '';
};

function ToolButton({ command, children, disabled }: { command: string; children: React.ReactNode; disabled?: boolean }) {
  const title = commands.find((c) => c.id === command)!.title + shortcutOf(command);
  return (
    <button className="icon-btn" title={title} aria-label={title} disabled={disabled} onClick={() => runCommand(command)}>
      {children}
    </button>
  );
}

function LabelButton({ command, label, children }: { command: string; label: string; children: React.ReactNode }) {
  const c = commands.find((x) => x.id === command)!;
  return (
    <button className="tool-label" title={c.description + shortcutOf(command)} onClick={() => runCommand(command)}>
      {children} {label}
    </button>
  );
}

function Toolbar() {
  const hasSelection = useStore((s) => s.selection.length > 0);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const pxPerSec = useStore((s) => s.pxPerSec);
  const setZoom = useStore((s) => s.setZoom);
  return (
    <div className="tl-toolbar">
      <ToolButton command="edit.undo" disabled={!canUndo}><Undo2 size={16} /></ToolButton>
      <ToolButton command="edit.redo" disabled={!canRedo}><Redo2 size={16} /></ToolButton>
      <span className="sep" />
      <ToolButton command="edit.split"><Scissors size={16} /></ToolButton>
      <ToolButton command="edit.duplicate" disabled={!hasSelection}><Copy size={16} /></ToolButton>
      <ToolButton command="edit.delete" disabled={!hasSelection}><Trash2 size={16} /></ToolButton>
      <span className="sep" />
      <ToolButton command="insert.text"><Type size={16} /></ToolButton>
      <ToolButton command="insert.rect"><Square size={16} /></ToolButton>
      <ToolButton command="insert.ellipse"><Circle size={16} /></ToolButton>
      <ToolButton command="insert.arrow"><ArrowRight size={16} /></ToolButton>
      <ToolButton command="insert.pulse"><MousePointerClick size={16} /></ToolButton>
      <span className="sep" />
      <LabelButton command="insert.zoom" label="Zoom"><ZoomIn size={14} /></LabelButton>
      <LabelButton command="insert.blur" label="Blur"><Droplet size={14} /></LabelButton>
      <LabelButton command="insert.spotlight" label="Spotlight"><Focus size={14} /></LabelButton>
      <LabelButton command="clip.addTransition" label="Transition"><Blend size={14} /></LabelButton>
      <span className="grow" />
      <ToolButton command="view.zoomFit"><Maximize2 size={15} /></ToolButton>
      <ToolButton command="view.zoomOut"><Minus size={16} /></ToolButton>
      <input
        className="zoom-slider"
        type="range"
        aria-label="Timeline zoom"
        min={Math.log(4)}
        max={Math.log(600)}
        step={0.01}
        value={Math.log(pxPerSec)}
        onChange={(e) => setZoom(Math.exp(Number(e.target.value)))}
      />
      <ToolButton command="view.zoomIn"><Plus size={16} /></ToolButton>
    </div>
  );
}

function TrackHeader({ track, removable }: { track: Track; removable: boolean }) {
  const commit = useStore((s) => s.commit);
  const patch = (p: Partial<Track>) => commit((proj) => edit.updateTrack(proj, track.id, p));
  return (
    <div className="tl-header" style={{ height: LANE_H[track.kind] }}>
      <input
        className="track-name"
        value={track.name}
        aria-label="Track name"
        onFocus={armHistory}
        onChange={(e) => liveEdit((p) => edit.updateTrack(p, track.id, { name: e.target.value }))}
      />
      <div className="track-btns">
        <button className={`mini-btn ${track.muted ? 'on' : ''}`} title={track.muted ? 'Unmute track' : 'Mute track'} onClick={() => patch({ muted: !track.muted })}>
          {track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
        </button>
        {track.kind === 'video' && (
          <button className={`mini-btn ${track.hidden ? 'on' : ''}`} title={track.hidden ? 'Show track' : 'Hide track'} onClick={() => patch({ hidden: !track.hidden })}>
            {track.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        )}
        <button className={`mini-btn ${track.locked ? 'on' : ''}`} title={track.locked ? 'Unlock track' : 'Lock track'} onClick={() => patch({ locked: !track.locked })}>
          {track.locked ? <Lock size={13} /> : <LockOpen size={13} />}
        </button>
        {removable && (
          <button
            className="mini-btn"
            title="Delete track"
            onClick={() => commit((p) => edit.removeTrack(p, track.id))}
          >
            <X size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

function Waveform({ clip, peaks, width, height }: { clip: Clip; peaks: Float32Array; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const w = Math.max(1, Math.min(4096, Math.round(width)));
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    canvas.width = w;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, w, height);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    const from = clip.offset * PEAKS_PER_SECOND;
    const span = clip.duration * clip.speed * PEAKS_PER_SECOND;
    for (let x = 0; x < w; x++) {
      const a = Math.floor(from + (x / w) * span);
      const b = Math.max(a + 1, Math.floor(from + ((x + 1) / w) * span));
      let peak = 0;
      for (let i = a; i < b && i < peaks.length; i++) if (peaks[i] > peak) peak = peaks[i];
      const h = Math.max(1, peak * clip.volume * height);
      ctx.fillRect(x, (height - h) / 2, 1, h);
    }
  }, [clip.offset, clip.duration, clip.speed, clip.volume, peaks, w, height]);
  return <canvas ref={ref} className="waveform" style={{ height }} />;
}

function Filmstrip({ clip, rt, mediaDuration, width, height }: { clip: Clip; rt: MediaRuntime; mediaDuration: number; width: number; height: number }) {
  const fs = rt.filmstrip!;
  const k = height / fs.height;
  const natural = fs.width * k;
  const count = Math.min(80, Math.max(1, Math.ceil(width / natural)));
  const tileW = width / count;
  const tiles = [];
  for (let i = 0; i < count; i++) {
    const t = clip.offset + ((i + 0.5) / count) * clip.duration * clip.speed;
    const index = Math.min(fs.count - 1, Math.max(0, Math.floor((t / Math.max(0.001, mediaDuration)) * fs.count)));
    tiles.push(
      <div
        key={i}
        className="film-tile"
        style={{
          left: i * tileW,
          width: tileW + 0.5,
          backgroundImage: `url(${fs.url})`,
          backgroundSize: `${fs.count * natural}px ${height}px`,
          backgroundPosition: `${-index * natural - Math.max(0, (natural - tileW) / 2)}px 0`,
        }}
      />,
    );
  }
  return <div className="filmstrip">{tiles}</div>;
}

const ClipView = memo(function ClipView({
  clip, selected, pxPerSec, laneH, locked, onPointerDown,
}: {
  clip: Clip; selected: boolean; pxPerSec: number; laneH: number; locked: boolean;
  onPointerDown: (e: React.PointerEvent, clip: Clip, mode: 'move' | 'start' | 'end') => void;
}) {
  const media = useStore((s) => (clip.mediaId ? s.project.media.find((m) => m.id === clip.mediaId) : undefined));
  const rt = useStore((s) => (clip.mediaId ? s.runtime[clip.mediaId] : undefined));
  const width = Math.max(2, clip.duration * pxPerSec);
  const inner = laneH - 8;
  const label =
    clip.type === 'text' ? clip.text!.content.split('\n')[0]
    : clip.type === 'shape' ? (clip.shape!.kind === 'pulse' ? 'click pulse' : clip.shape!.kind)
    : clip.type === 'zoom' ? `Zoom ${(1 / clip.scale).toFixed(1)}×`
    : clip.type === 'effect' ? clip.effect!.kind
    : media?.name ?? 'Missing media';
  const fx = clip.type === 'effect' ? `fx-${clip.effect!.kind}` : '';
  const showWave = !!rt?.peaks && (clip.type === 'audio' || clip.type === 'video');
  return (
    <div
      className={`clip clip-${clip.type} ${fx} ${selected ? 'selected' : ''} ${locked ? 'locked' : ''}`}
      style={{ left: clip.start * pxPerSec, width, height: inner }}
      data-clip-id={clip.id}
      onPointerDown={(e) => onPointerDown(e, clip, 'move')}
    >
      {clip.type === 'video' && rt?.filmstrip && media && (
        <Filmstrip clip={clip} rt={rt} mediaDuration={media.duration} width={width} height={inner} />
      )}
      {clip.type === 'image' && rt && <div className="filmstrip still" style={{ backgroundImage: `url(${rt.url})` }} />}
      {showWave && <Waveform clip={clip} peaks={rt!.peaks!} width={width} height={clip.type === 'audio' ? inner : Math.round(inner * 0.4)} />}
      {clip.transition && canTransition(clip) && (
        <div className="transition-mark" style={{ width: clip.transition.duration * pxPerSec }} title={`Transition: ${clip.transition.type}`}>
          <Blend size={12} />
        </div>
      )}
      {clip.fadeIn > 0 && <div className="fade fade-in" style={{ width: clip.fadeIn * pxPerSec }} />}
      {clip.fadeOut > 0 && <div className="fade fade-out" style={{ width: clip.fadeOut * pxPerSec }} />}
      <span className="clip-label">
        {label}
        {clip.speed !== 1 && <em> {clip.speed}×</em>}
      </span>
      {!locked && (
        <>
          <div className="trim trim-start" onPointerDown={(e) => onPointerDown(e, clip, 'start')} />
          <div className="trim trim-end" onPointerDown={(e) => onPointerDown(e, clip, 'end')} />
        </>
      )}
    </div>
  );
});

function Ruler({ pxPerSec, from, to, fps }: { pxPerSec: number; from: number; to: number; fps: number }) {
  const step = TICK_STEPS.find((s) => s * pxPerSec >= 72) ?? 3600;
  const ticks = [];
  for (let t = Math.floor(from / step) * step; t <= to; t += step) {
    const label = step < 1 ? formatTime(t + 1e-6, fps) : formatTime(t + 1e-6, fps).slice(0, 5);
    ticks.push(
      <div key={t.toFixed(3)} className="tick" style={{ left: t * pxPerSec }}>
        <span>{label}</span>
      </div>,
    );
  }
  return <>{ticks}</>;
}

function Playhead({ scrollRef }: { scrollRef: React.RefObject<HTMLDivElement | null> }) {
  const playhead = useStore((s) => s.playhead);
  const pxPerSec = useStore((s) => s.pxPerSec);
  const playing = useStore((s) => s.playing);
  const x = playhead * pxPerSec;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !playing) return;
    const view = el.clientWidth - HEADER_W;
    if (x > el.scrollLeft + view - 40 || x < el.scrollLeft) el.scrollLeft = Math.max(0, x - 80);
  }, [x, playing, scrollRef]);
  return (
    <div className="playhead" style={{ transform: `translateX(${HEADER_W + x}px)` }}>
      <div className="playhead-knob" />
    </div>
  );
}

export function Timeline() {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const pxPerSec = useStore((s) => s.pxPerSec);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ left: 0, width: 1200 });
  const [snapX, setSnapX] = useState<number | null>(null);
  const [dropTrack, setDropTrack] = useState<string | null>(null);

  const duration = useMemo(() => edit.projectDuration(project), [project]);
  const contentW = Math.max((duration + 30) * pxPerSec, view.width);

  useLayoutEffect(() => {
    const el = scrollRef.current!;
    const update = () => setView({ left: el.scrollLeft, width: el.clientWidth - HEADER_W });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    el.addEventListener('scroll', update, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', update);
    };
  }, []);

  // Ctrl/Cmd + wheel zooms around the pointer.
  useEffect(() => {
    const el = scrollRef.current!;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const { pxPerSec: old, setZoom } = useStore.getState();
      const x = e.clientX - el.getBoundingClientRect().left - HEADER_W;
      const time = (el.scrollLeft + x) / old;
      setZoom(old * Math.exp(-e.deltaY * 0.004));
      const next = useStore.getState().pxPerSec;
      requestAnimationFrame(() => (el.scrollLeft = time * next - x));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const timeAt = (clientX: number) => {
    const el = scrollRef.current!;
    return Math.max(0, (clientX - el.getBoundingClientRect().left - HEADER_W + el.scrollLeft) / useStore.getState().pxPerSec);
  };

  /** Snap a time to nearby clip edges / the playhead. Returns the snapped time. */
  const snapper = (ignoreId: string) => {
    const { project: p, playhead } = useStore.getState();
    const points = [0, playhead, ...p.clips.filter((c) => c.id !== ignoreId).flatMap((c) => [c.start, clipEnd(c)])];
    return (candidates: number[]): number => {
      const tolerance = SNAP_PX / useStore.getState().pxPerSec;
      let best = { delta: 0, dist: tolerance, point: null as number | null };
      for (const c of candidates)
        for (const pt of points) {
          const dist = Math.abs(pt - c);
          if (dist < best.dist) best = { delta: pt - c, dist, point: pt };
        }
      setSnapX(best.point);
      return best.delta;
    };
  };

  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const { setPlayhead, setPlaying } = useStore.getState();
    setPlaying(false);
    setPlayhead(timeAt(e.clientX));
    startDrag(e, (_dx, _dy, ev) => setPlayhead(timeAt(ev.clientX)));
  };

  const onClipPointerDown = (e: React.PointerEvent, clip: Clip, mode: 'move' | 'start' | 'end') => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const store = useStore.getState();
    if (store.project.tracks.find((t) => t.id === clip.trackId)?.locked) return;
    if (e.shiftKey || e.metaKey || e.ctrlKey) store.toggleSelect(clip.id);
    else if (!store.selection.includes(clip.id)) store.select([clip.id]);

    const grab = timeAt(e.clientX) - clip.start;
    const snap = snapper(clip.id);
    let started = false;
    startDrag(
      e,
      (_dx, _dy, ev) => {
        if (!started) {
          started = true;
          store.checkpoint();
        }
        const t = timeAt(ev.clientX);
        if (mode === 'move') {
          const lane = document.elementsFromPoint(ev.clientX, ev.clientY).find((el) => el.classList.contains('tl-lane'));
          const trackId = (lane as HTMLElement | undefined)?.dataset.trackId;
          let start = Math.max(0, t - grab);
          if (!ev.altKey) start += snap([start, start + clip.duration]);
          store.mutate((p) => edit.moveClip(p, clip.id, start, trackId));
        } else {
          const time = ev.altKey ? t : t + snap([t]);
          store.mutate((p) => edit.trimClip(p, clip.id, mode, time));
        }
      },
      (moved) => {
        setSnapX(null);
        // A plain click on one clip of a multi-selection narrows the selection to it.
        if (!moved && !e.shiftKey && !e.metaKey && !e.ctrlKey) useStore.getState().select([clip.id]);
      },
    );
  };

  const onLaneDrop = async (e: React.DragEvent, track?: Track) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTrack(null);
    const start = timeAt(e.clientX);
    const mediaId = e.dataTransfer.getData(MEDIA_DRAG_TYPE);
    if (mediaId) {
      addMediaToTimeline(mediaId, { start, trackId: track?.id });
      return;
    }
    const files = filesFromDrop(e);
    if (!files.length) return;
    let at = start;
    for (const id of await useStore.getState().importFiles(files)) {
      const clipId = addMediaToTimeline(id, { start: at, trackId: track?.id });
      const clip = clipId && edit.getClip(useStore.getState().project, clipId);
      if (clip) at = clipEnd(clip);
    }
  };

  const allowDrop = (e: React.DragEvent, trackId: string | null) => {
    if (!e.dataTransfer.types.includes(MEDIA_DRAG_TYPE) && !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (dropTrack !== trackId) setDropTrack(trackId);
  };

  const counts = { video: project.tracks.filter((t) => t.kind === 'video').length, audio: project.tracks.filter((t) => t.kind === 'audio').length };

  return (
    <section className="timeline" aria-label="Timeline">
      <Toolbar />
      <div
        className="tl-scroll"
        ref={scrollRef}
        onDragOver={(e) => allowDrop(e, null)}
        onDragLeave={() => setDropTrack(null)}
        onDrop={(e) => void onLaneDrop(e)}
      >
        <div className="tl-content" style={{ width: HEADER_W + contentW }}>
          <div className="tl-row tl-ruler-row" style={{ height: RULER_H }}>
            <div className="tl-header tl-corner" style={{ height: RULER_H }}>
              <button className="mini-btn wide" title="Add video track" onClick={() => runCommand('track.addVideo')}>
                <Plus size={12} /> Video
              </button>
              <button className="mini-btn wide" title="Add audio track" onClick={() => runCommand('track.addAudio')}>
                <Plus size={12} /> Audio
              </button>
            </div>
            <div className="tl-ruler" onPointerDown={scrub}>
              <Ruler pxPerSec={pxPerSec} from={view.left / pxPerSec} to={(view.left + view.width) / pxPerSec} fps={project.fps} />
            </div>
          </div>
          {project.tracks.map((track) => (
            <div className="tl-row" key={track.id}>
              <TrackHeader track={track} removable={counts[track.kind] > 1} />
              <div
                className={`tl-lane lane-${track.kind} ${track.locked ? 'locked' : ''} ${track.hidden ? 'hidden' : ''} ${dropTrack === track.id ? 'drop' : ''}`}
                style={{ height: LANE_H[track.kind] }}
                data-track-id={track.id}
                onPointerDown={(e) => {
                  useStore.getState().select([]);
                  scrub(e);
                }}
                onDragOver={(e) => {
                  e.stopPropagation();
                  allowDrop(e, track.id);
                }}
                onDrop={(e) => void onLaneDrop(e, track)}
              >
                {project.clips
                  .filter((c) => c.trackId === track.id)
                  .map((clip) => (
                    <ClipView
                      key={clip.id}
                      clip={clip}
                      selected={selection.includes(clip.id)}
                      pxPerSec={pxPerSec}
                      laneH={LANE_H[track.kind]}
                      locked={track.locked}
                      onPointerDown={onClipPointerDown}
                    />
                  ))}
              </div>
            </div>
          ))}
          {snapX !== null && <div className="snap-line" style={{ left: HEADER_W + snapX * pxPerSec }} />}
          <Playhead scrollRef={scrollRef} />
        </div>
      </div>
    </section>
  );
}
