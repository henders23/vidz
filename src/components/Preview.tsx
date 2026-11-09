import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronFirst, ChevronLast, Pause, Play, StepBack, StepForward, Upload, Video } from 'lucide-react';
import { Clip, Project } from '../types';
import { useStore } from '../store';
import * as edit from '../lib/edit';
import { editingZoomId, preview } from '../lib/playback';
import { clipSize } from '../lib/render';
import { runCommand } from '../lib/commands';
import { canRecordScreen } from '../lib/recorder';
import { formatTime, startDrag } from '../lib/util';

/** Top-most visual clip under a canvas-space point. */
function hitTest(project: Project, time: number, sx: number, sy: number, bypass?: string): Clip | null {
  const locked = new Set(project.tracks.filter((t) => t.locked).map((t) => t.id));
  for (const clip of edit.visibleClips(project, time).reverse()) {
    // Zoom clips cover the whole frame, so they are selected from the timeline instead.
    if (locked.has(clip.trackId) || clip.type === 'zoom') continue;
    const { width, height } = clipSize(clip, project);
    // Undo any zoom above this clip to get from on-screen to canvas coordinates.
    const view = edit.zoomTransform(project, time, clip.trackId, bypass);
    const dx = (sx - view.tx) / view.k - (project.width / 2 + clip.x);
    const dy = (sy - view.ty) / view.k - (project.height / 2 + clip.y);
    const a = (-clip.rotation * Math.PI) / 180;
    const lx = (dx * Math.cos(a) - dy * Math.sin(a)) / clip.scale;
    const ly = (dx * Math.sin(a) + dy * Math.cos(a)) / clip.scale;
    if (Math.abs(lx) <= width / 2 && Math.abs(ly) <= height / 2) return clip;
  }
  return null;
}

function Transport() {
  const playing = useStore((s) => s.playing);
  const playhead = useStore((s) => s.playhead);
  const fps = useStore((s) => s.project.fps);
  const duration = useStore((s) => edit.projectDuration(s.project));
  return (
    <div className="transport">
      <span className="timecode" aria-label="Current time">{formatTime(playhead, fps)}</span>
      <div className="transport-btns">
        <button className="icon-btn" title="Go to start (Home)" onClick={() => runCommand('playback.start')}><ChevronFirst size={18} /></button>
        <button className="icon-btn" title="Previous frame (←)" onClick={() => runCommand('playback.prevFrame')}><StepBack size={16} /></button>
        <button className="play-btn" title="Play / Pause (Space)" aria-label={playing ? 'Pause' : 'Play'} onClick={() => runCommand('playback.toggle')}>
          {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
        </button>
        <button className="icon-btn" title="Next frame (→)" onClick={() => runCommand('playback.nextFrame')}><StepForward size={16} /></button>
        <button className="icon-btn" title="Go to end (End)" onClick={() => runCommand('playback.end')}><ChevronLast size={18} /></button>
      </div>
      <span className="timecode dim" aria-label="Project duration">{formatTime(duration, fps)}</span>
    </div>
  );
}

export function Preview() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const playhead = useStore((s) => s.playhead);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [guides, setGuides] = useState({ x: false, y: false });
  const playing = useStore((s) => s.playing);

  useEffect(() => preview.attach(canvasRef.current!), []);

  // Fit the canvas inside the stage while preserving the project's aspect ratio.
  useLayoutEffect(() => {
    const stage = stageRef.current!;
    const fit = () => {
      const availW = stage.clientWidth - 32;
      const availH = stage.clientHeight - 32;
      const k = Math.max(0.01, Math.min(availW / project.width, availH / project.height));
      setBox({ width: project.width * k, height: project.height * k });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [project.width, project.height]);

  const k = box.width / project.width || 1;
  const selected = selection.length === 1 ? edit.getClip(project, selection[0]) : undefined;
  const showBox =
    selected && selected.type !== 'audio' && playhead >= selected.start && playhead < selected.start + selected.duration &&
    !(selected.type === 'zoom' && playing);
  const size = showBox ? clipSize(selected, project) : null;
  const bypass = editingZoomId(project, selection, playing);
  // How zooms above the selected clip move and scale it on screen.
  const view = showBox ? edit.zoomTransform(project, playhead, selected.trackId, bypass) : { k: 1, tx: 0, ty: 0 };
  const shown = showBox && selected.type === 'zoom' ? { ...selected, ...edit.zoomCentre(selected, project) } : selected;

  const toCanvas = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const store = useStore.getState();
    const pt = toCanvas(e);
    const clip = hitTest(store.project, store.playhead, pt.x, pt.y, editingZoomId(store.project, store.selection, store.playing));
    store.select(clip ? [clip.id] : []);
    if (!clip) return;
    store.setPlaying(false);
    beginMove(e, clip);
  };

  const beginMove = (e: React.PointerEvent, clip: Clip) => {
    const store = useStore.getState();
    const zoomK = edit.zoomTransform(store.project, store.playhead, clip.trackId, editingZoomId(store.project, [clip.id], false)).k;
    let started = false;
    const snapDist = 10 / k;
    startDrag(
      e,
      (dx, dy, ev) => {
        if (!started) {
          started = true;
          store.checkpoint();
        }
        let x = clip.x + dx / k / zoomK;
        let y = clip.y + dy / k / zoomK;
        if (clip.type === 'zoom') ({ x, y } = edit.zoomCentre({ ...clip, x, y }, store.project));
        const snapX = !ev.altKey && Math.abs(x) < snapDist;
        const snapY = !ev.altKey && Math.abs(y) < snapDist;
        if (snapX) x = 0;
        if (snapY) y = 0;
        setGuides({ x: snapX, y: snapY });
        store.mutate((p) => edit.updateClip(p, clip.id, { x, y }));
      },
      () => setGuides({ x: false, y: false }),
    );
  };

  const onHandleDown = (e: React.PointerEvent) => {
    if (!selected || !shown) return;
    e.stopPropagation();
    const store = useStore.getState();
    const clip = selected;
    // Work in on-screen canvas pixels, where the box centre sits after any zoom above the clip.
    const centre = { x: view.tx + view.k * (project.width / 2 + shown.x), y: view.ty + view.k * (project.height / 2 + shown.y) };
    const start = toCanvas(e);
    const d0 = Math.max(1, Math.hypot(start.x - centre.x, start.y - centre.y));
    const angle = (-clip.rotation * Math.PI) / 180;
    let started = false;
    startDrag(e, (_dx, _dy, ev) => {
      if (!started) {
        started = true;
        store.checkpoint();
      }
      const pt = toCanvas(ev);
      const dx = pt.x - centre.x;
      const dy = pt.y - centre.y;
      const box = clip.type === 'effect' ? 'effect' : clip.type === 'shape' && clip.shape!.kind !== 'pulse' ? 'shape' : null;
      if (box) {
        // Regions and shapes resize freely (from the centre) so they can match what they cover.
        const unit = view.k * clip.scale;
        const width = Math.max(8, (Math.abs(dx * Math.cos(angle) - dy * Math.sin(angle)) * 2) / unit);
        const height = Math.max(8, (Math.abs(dx * Math.sin(angle) + dy * Math.cos(angle)) * 2) / unit);
        store.mutate((p) => edit.updateClip(p, clip.id, { [box]: { ...clip[box]!, width, height } }));
        return;
      }
      let scale = Math.max(0.02, (clip.scale * Math.hypot(dx, dy)) / d0);
      if (clip.type === 'zoom') scale = Math.min(1, Math.max(0.1, scale));
      store.mutate((p) => edit.updateClip(p, clip.id, { scale }));
    });
  };

  const empty = project.clips.length === 0;

  return (
    <section className="preview" aria-label="Preview">
      <div className="stage" ref={stageRef}>
        <div className={`canvas-wrap ${bypass ? 'zooming' : ''}`} style={{ width: box.width, height: box.height }} onPointerDown={onPointerDown}>
          <canvas ref={canvasRef} width={project.width} height={project.height} />
          {guides.x && <div className="guide guide-v" />}
          {guides.y && <div className="guide guide-h" />}
          {showBox && size && shown && (
            <div
              className={`select-box ${selected.type === 'zoom' ? 'zoom-area' : ''}`}
              style={{
                width: size.width * shown.scale * view.k * k,
                height: size.height * shown.scale * view.k * k,
                left: (view.tx + view.k * (project.width / 2 + shown.x)) * k,
                top: (view.ty + view.k * (project.height / 2 + shown.y)) * k,
                transform: `translate(-50%, -50%) rotate(${selected.type === 'zoom' ? 0 : selected.rotation}deg)`,
              }}
              onPointerDown={selected.type === 'zoom' ? (e) => { e.stopPropagation(); beginMove(e, selected); } : undefined}
            >
              {selected.type === 'zoom' && <span className="zoom-label">Zoom area · {(1 / shown.scale).toFixed(1)}×</span>}
              {['nw', 'ne', 'sw', 'se'].map((corner) => (
                <div key={corner} className={`handle handle-${corner}`} onPointerDown={onHandleDown} />
              ))}
            </div>
          )}
          {empty && (
            <div className="empty-state" onPointerDown={(e) => e.stopPropagation()}>
              <h2>Start your video</h2>
              <p>Drop files anywhere, import media, or record your screen.</p>
              <div className="empty-actions">
                <button className="btn primary" onClick={() => runCommand('file.import')}><Upload size={16} /> Import media</button>
                {canRecordScreen() && (
                  <button className="btn" onClick={() => runCommand('file.record')}><Video size={16} /> Record</button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      <Transport />
    </section>
  );
}
