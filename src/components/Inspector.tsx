import { AlignCenter, AlignLeft, AlignRight, Bold, Captions, ChevronLeft, ChevronRight, Diamond, Italic, SlidersHorizontal, Sparkles } from 'lucide-react';
import { Assistant } from './Assistant';
import { Transcript } from './Transcript';
import { Clip, EffectKind, EffectProps, Filters, Project, ShapeProps, TextProps, TransitionType, canTransition } from '../types';
import { armHistory, liveEdit, useStore } from '../store';
import * as edit from '../lib/edit';
import { clipSize } from '../lib/render';
import { formatTime } from '../lib/util';

const FONTS = [
  ['Sans', 'Inter, system-ui, sans-serif'],
  ['Serif', 'Georgia, "Times New Roman", serif'],
  ['Mono', '"SF Mono", Consolas, "Courier New", monospace'],
  ['Impact', 'Impact, "Arial Black", sans-serif'],
  ['Rounded', '"Trebuchet MS", "Segoe UI", sans-serif'],
  ['Handwriting', '"Comic Sans MS", "Bradley Hand", cursive'],
];

const PRESETS: [string, number, number][] = [
  ['1080p · 16:9', 1920, 1080],
  ['4K · 16:9', 3840, 2160],
  ['720p · 16:9', 1280, 720],
  ['Vertical · 9:16', 1080, 1920],
  ['Square · 1:1', 1080, 1080],
  ['Portrait · 4:5', 1080, 1350],
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="insp-section">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="insp-row">
      <span>{label}</span>
      <div className="insp-control">{children}</div>
    </label>
  );
}

function Slider({
  label, value, min, max, step, onChange, display, reset,
}: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; display?: (v: number) => string; reset?: number;
}) {
  return (
    <Row label={label}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={armHistory}
        onKeyDown={armHistory}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => reset !== undefined && onChange(reset)}
        title={reset !== undefined ? 'Double-click to reset' : undefined}
      />
      <output>{display ? display(value) : value}</output>
    </Row>
  );
}

function NumberField({ value, onChange, step = 1, min, max, suffix }: { value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; suffix?: string }) {
  return (
    <span className="num-field">
      <input
        type="number"
        value={Number.isFinite(value) ? Math.round(value * 100) / 100 : 0}
        step={step}
        min={min}
        max={max}
        onFocus={armHistory}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (e.target.value !== '' && Number.isFinite(v)) onChange(v);
        }}
      />
      {suffix && <i>{suffix}</i>}
    </span>
  );
}

function ColorField({ value, onChange, optional }: { value: string; onChange: (v: string) => void; optional?: boolean }) {
  return (
    <span className="color-field">
      {optional && (
        <input type="checkbox" checked={!!value} aria-label="Enabled" onChange={(e) => { armHistory(); onChange(e.target.checked ? '#000000' : ''); }} />
      )}
      <input type="color" value={value || '#000000'} disabled={optional && !value} onPointerDown={armHistory} onFocus={armHistory} onChange={(e) => onChange(e.target.value)} />
    </span>
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const secs = (v: number) => `${v.toFixed(1)}s`;

function ProjectSettings({ project }: { project: Project }) {
  const set = (patch: Partial<Project>) => liveEdit((p) => ({ ...p, ...patch }));
  const preset = PRESETS.find(([, w, h]) => w === project.width && h === project.height);
  return (
    <>
      <Section title="Project">
        <Row label="Canvas">
          <select
            value={preset ? preset[0] : 'custom'}
            onChange={(e) => {
              const p = PRESETS.find(([name]) => name === e.target.value);
              if (p) { armHistory(); set({ width: p[1], height: p[2] }); }
            }}
          >
            {PRESETS.map(([name]) => <option key={name}>{name}</option>)}
            {!preset && <option value="custom">Custom</option>}
          </select>
        </Row>
        <Row label="Size">
          <NumberField value={project.width} min={16} max={7680} onChange={(v) => set({ width: Math.max(16, Math.round(v)) })} />
          <span className="times">×</span>
          <NumberField value={project.height} min={16} max={4320} onChange={(v) => set({ height: Math.max(16, Math.round(v)) })} />
        </Row>
        <Row label="Frame rate">
          <select value={project.fps} onChange={(e) => { armHistory(); set({ fps: Number(e.target.value) }); }}>
            {[24, 25, 30, 50, 60].map((f) => <option key={f} value={f}>{f} fps</option>)}
          </select>
        </Row>
        <Row label="Background">
          <ColorField value={project.background} onChange={(background) => set({ background })} />
        </Row>
      </Section>
      <p className="insp-hint">Select a clip on the timeline or in the preview to edit its properties.</p>
    </>
  );
}

function TextSection({ clip, set }: { clip: Clip; set: (patch: Partial<Clip>) => void }) {
  const t = clip.text!;
  const setText = (patch: Partial<TextProps>) => set({ text: { ...t, ...patch } });
  const toggle = (patch: Partial<TextProps>) => { armHistory(); setText(patch); };
  return (
    <Section title="Text">
      <textarea
        className="text-content"
        value={t.content}
        rows={3}
        aria-label="Text content"
        onFocus={armHistory}
        onChange={(e) => setText({ content: e.target.value })}
      />
      <Row label="Font">
        <select value={t.fontFamily} onChange={(e) => toggle({ fontFamily: e.target.value })}>
          {FONTS.map(([name, family]) => <option key={name} value={family}>{name}</option>)}
        </select>
      </Row>
      <Row label="Size">
        <NumberField value={t.fontSize} min={8} max={1000} onChange={(v) => setText({ fontSize: Math.max(8, v) })} suffix="px" />
        <span className="seg">
          <button className={t.bold ? 'on' : ''} title="Bold" onClick={() => toggle({ bold: !t.bold })}><Bold size={14} /></button>
          <button className={t.italic ? 'on' : ''} title="Italic" onClick={() => toggle({ italic: !t.italic })}><Italic size={14} /></button>
        </span>
      </Row>
      <Row label="Align">
        <span className="seg">
          <button className={t.align === 'left' ? 'on' : ''} title="Align left" onClick={() => toggle({ align: 'left' })}><AlignLeft size={14} /></button>
          <button className={t.align === 'center' ? 'on' : ''} title="Align centre" onClick={() => toggle({ align: 'center' })}><AlignCenter size={14} /></button>
          <button className={t.align === 'right' ? 'on' : ''} title="Align right" onClick={() => toggle({ align: 'right' })}><AlignRight size={14} /></button>
        </span>
      </Row>
      <Row label="Colour"><ColorField value={t.color} onChange={(color) => setText({ color })} /></Row>
      <Row label="Background"><ColorField optional value={t.background} onChange={(background) => setText({ background })} /></Row>
      <Row label="Outline">
        <ColorField value={t.outline} onChange={(outline) => setText({ outline })} />
        <NumberField value={t.outlineWidth} min={0} max={100} onChange={(v) => setText({ outlineWidth: Math.max(0, v) })} suffix="px" />
      </Row>
    </Section>
  );
}

function ShapeSection({ clip, set }: { clip: Clip; set: (patch: Partial<Clip>) => void }) {
  const sh = clip.shape!;
  const setShape = (patch: Partial<ShapeProps>) => set({ shape: { ...sh, ...patch } });
  return (
    <Section title={sh.kind === 'pulse' ? 'Click pulse' : 'Shape'}>
      <Row label="Size">
        <NumberField value={sh.width} min={2} onChange={(v) => setShape({ width: Math.max(2, v) })} />
        <span className="times">×</span>
        <NumberField value={sh.height} min={2} onChange={(v) => setShape({ height: Math.max(2, v) })} />
      </Row>
      {sh.kind !== 'pulse' && <Row label="Fill"><ColorField optional value={sh.fill} onChange={(fill) => setShape({ fill })} /></Row>}
      <Row label={sh.kind === 'pulse' ? 'Ring' : 'Border'}>
        <ColorField value={sh.stroke} onChange={(stroke) => setShape({ stroke })} />
        <NumberField value={sh.strokeWidth} min={0} max={200} onChange={(v) => setShape({ strokeWidth: Math.max(0, v) })} suffix="px" />
      </Row>
      {sh.kind === 'rect' && (
        <Row label="Corners"><NumberField value={sh.radius} min={0} onChange={(v) => setShape({ radius: Math.max(0, v) })} suffix="px" /></Row>
      )}
    </Section>
  );
}

const EFFECT_LABEL: Record<EffectKind, string> = { blur: 'Blur', pixelate: 'Pixelate', spotlight: 'Spotlight' };

function EffectSection({ clip, set }: { clip: Clip; set: (patch: Partial<Clip>) => void }) {
  const fx = clip.effect!;
  const setFx = (patch: Partial<EffectProps>) => set({ effect: { ...fx, ...patch } });
  return (
    <Section title="Region effect">
      <Row label="Effect">
        <select
          value={fx.kind}
          onChange={(e) => {
            const kind = e.target.value as EffectKind;
            armHistory();
            setFx({ kind, amount: edit.EFFECT_DEFAULT_AMOUNT[kind] });
          }}
        >
          {(Object.keys(EFFECT_LABEL) as EffectKind[]).map((k) => <option key={k} value={k}>{EFFECT_LABEL[k]}</option>)}
        </select>
      </Row>
      <Row label="Shape">
        <span className="seg text">
          <button className={fx.region === 'rect' ? 'on' : ''} onClick={() => { armHistory(); setFx({ region: 'rect' }); }}>Rectangle</button>
          <button className={fx.region === 'ellipse' ? 'on' : ''} onClick={() => { armHistory(); setFx({ region: 'ellipse' }); }}>Ellipse</button>
        </span>
      </Row>
      {fx.kind === 'spotlight' ? (
        <Slider label="Dimming" value={fx.amount} min={0.1} max={1} step={0.01} display={pct} reset={0.7} onChange={(amount) => setFx({ amount })} />
      ) : (
        <Slider label="Strength" value={fx.amount} min={2} max={80} step={1} display={(v) => `${v}px`} reset={24} onChange={(amount) => setFx({ amount })} />
      )}
      <Row label="Size">
        <NumberField value={fx.width} min={8} onChange={(v) => setFx({ width: Math.max(8, v) })} />
        <span className="times">×</span>
        <NumberField value={fx.height} min={8} onChange={(v) => setFx({ height: Math.max(8, v) })} />
      </Row>
      <Row label="Position">
        <NumberField value={clip.x} onChange={(x) => set({ x })} suffix="X" />
        <NumberField value={clip.y} onChange={(y) => set({ y })} suffix="Y" />
      </Row>
      <p className="insp-hint">Drag the box in the preview to place it; drag a corner to resize. It affects everything on the tracks below.</p>
    </Section>
  );
}

function ZoomSection({ clip, set }: { clip: Clip; set: (patch: Partial<Clip>) => void }) {
  const maxEase = clip.duration / 2;
  return (
    <Section title="Zoom & pan">
      <Slider label="Zoom" value={1 / clip.scale} min={1} max={6} step={0.05} display={(v) => `${v.toFixed(1)}×`} reset={2} onChange={(level) => set({ scale: 1 / level })} />
      <Row label="Centre">
        <NumberField value={clip.x} onChange={(x) => set({ x })} suffix="X" />
        <NumberField value={clip.y} onChange={(y) => set({ y })} suffix="Y" />
      </Row>
      <Slider label="Zoom in" value={Math.min(clip.fadeIn, maxEase)} min={0} max={Math.min(3, maxEase)} step={0.05} display={secs2} reset={0.6} onChange={(fadeIn) => set({ fadeIn })} />
      <Slider label="Zoom out" value={Math.min(clip.fadeOut, maxEase)} min={0} max={Math.min(3, maxEase)} step={0.05} display={secs2} reset={0.6} onChange={(fadeOut) => set({ fadeOut })} />
      <p className="insp-hint">Drag the box in the preview over the area to zoom into. Everything on the tracks below zooms; stretch the clip on the timeline to hold the zoom longer.</p>
    </Section>
  );
}
const secs2 = (v: number) => `${v.toFixed(2)}s`;

const TRANSITIONS: [TransitionType, string][] = [
  ['dissolve', 'Cross dissolve'],
  ['wipe', 'Wipe'],
  ['push', 'Push'],
  ['zoom', 'Zoom'],
  ['dip', 'Fade through'],
];

function TransitionSection({ clip }: { clip: Clip }) {
  const tr = clip.transition;
  const apply = (type: TransitionType | null, duration = tr?.duration ?? 0.5) => liveEdit((p) => edit.setTransition(p, clip.id, type, duration));
  return (
    <Section title="Transition in">
      <Row label="Style">
        <select value={tr?.type ?? 'none'} onChange={(e) => { armHistory(); apply(e.target.value === 'none' ? null : (e.target.value as TransitionType)); }}>
          <option value="none">None</option>
          {TRANSITIONS.map(([type, label]) => <option key={type} value={type}>{label}</option>)}
        </select>
      </Row>
      {tr && (
        <Slider label="Duration" value={tr.duration} min={0.1} max={Math.max(0.1, Math.min(3, clip.duration))} step={0.05} display={secs2} reset={0.5} onChange={(d) => apply(tr.type, d)} />
      )}
      <p className="insp-hint">Blends from the clip that ends where this one begins on the same track.</p>
    </Section>
  );
}

const TRANSFORM_KEYS = new Set(['x', 'y', 'scale', 'rotation', 'opacity']);

function AnimationSection({ clip, project }: { clip: Clip; project: Project }) {
  const playhead = useStore((s) => s.playhead);
  const { setPlayhead, commit, toast } = useStore.getState();
  const kfs = clip.keyframes ?? [];
  const local = playhead - clip.start;
  const inside = local >= 0 && local <= clip.duration;
  const tolerance = 0.5 / project.fps;
  const current = kfs.findIndex((k) => Math.abs(k.time - local) <= tolerance);
  const visible = kfs.map((k, index) => ({ k, index })).filter(({ k }) => k.time >= -tolerance && k.time <= clip.duration + tolerance);
  const previous = [...visible].reverse().find(({ k }) => k.time < local - tolerance);
  const next = visible.find(({ k }) => k.time > local + tolerance);
  const add = () => {
    if (!inside) return toast('Move the playhead onto this clip to add a keyframe there');
    commit((p) => edit.setKeyframe(p, clip.id, playhead));
  };
  return (
    <Section title="Animation">
      <div className="insp-buttons">
        <button className="icon-btn boxed" title="Previous keyframe" aria-label="Previous keyframe" disabled={!previous} onClick={() => previous && setPlayhead(clip.start + previous.k.time)}><ChevronLeft size={15} /></button>
        {current >= 0 ? (
          <button className="btn small" onClick={() => commit((p) => edit.removeKeyframe(p, clip.id, current))}><Diamond size={12} fill="currentColor" /> Remove keyframe</button>
        ) : (
          <button className="btn small" onClick={add} title="Add a keyframe at the playhead (K)"><Diamond size={12} /> Add keyframe</button>
        )}
        <button className="icon-btn boxed" title="Next keyframe" aria-label="Next keyframe" disabled={!next} onClick={() => next && setPlayhead(clip.start + next.k.time)}><ChevronRight size={15} /></button>
      </div>
      {kfs.length === 0 ? (
        <p className="insp-hint">Add a keyframe, move the playhead, then move or resize the clip in the preview. It animates between the two, so it can follow something that moves.</p>
      ) : (
        <>
          <div className="kf-chips">
            {visible.map(({ k, index }) => (
              <button key={index} className={index === current ? 'on' : ''} onClick={() => setPlayhead(clip.start + Math.max(0, Math.min(clip.duration - 0.001, k.time)))}>
                {formatTime(clip.start + k.time, project.fps)}
              </button>
            ))}
          </div>
          <Row label="Motion">
            <select value={clip.motion ?? 'smooth'} onChange={(e) => commit((p) => edit.updateClip(p, clip.id, { motion: e.target.value as Clip['motion'] }))}>
              <option value="smooth">Smooth</option>
              <option value="linear">Constant speed</option>
            </select>
          </Row>
          <p className="insp-hint">Moving or resizing the clip at another time adds a keyframe there. Drag the diamonds on the timeline to retime them.</p>
          <div className="insp-buttons">
            <button className="btn small" onClick={() => commit((p) => edit.clearKeyframes(p, clip.id, playhead))}>Remove animation</button>
          </div>
        </>
      )}
    </Section>
  );
}

function ClipInspector({ clip: raw, project }: { clip: Clip; project: Project }) {
  // Show the clip as it looks at the playhead; an animated clip's values change over time.
  const playhead = useStore((s) => (edit.isAnimated(raw) ? s.playhead : 0));
  const clip = edit.resolveClip(raw, playhead);
  const set = (patch: Partial<Clip>) =>
    liveEdit((p) => {
      // Position, size, rotation and opacity go through applyTransform so that an
      // animated clip gets a keyframe at the playhead instead of a change that is ignored.
      const transform: Record<string, number> = {};
      const rest: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(patch)) (TRANSFORM_KEYS.has(key) ? transform : rest)[key] = value as number;
      for (const box of ['effect', 'shape'] as const) {
        const next = patch[box];
        const shown = clip[box];
        if (!next || !shown) continue;
        if (next.width !== shown.width) transform.width = next.width;
        if (next.height !== shown.height) transform.height = next.height;
      }
      const updated = Object.keys(rest).length ? edit.updateClip(p, raw.id, rest as Partial<Clip>) : p;
      return Object.keys(transform).length ? edit.applyTransform(updated, raw.id, useStore.getState().playhead, transform) : updated;
    });
  const setFilter = (patch: Partial<Filters>) => set({ filters: { ...clip.filters, ...patch } });
  const adjustment = clip.type === 'zoom' || clip.type === 'effect';
  const visual = clip.type !== 'audio' && !adjustment;
  const timed = clip.type === 'video' || clip.type === 'audio';
  const media = edit.getMedia(project, clip.mediaId);
  const fitTo = (mode: 'fit' | 'fill') => {
    const { width, height } = clipSize(clip, project);
    const sx = project.width / width;
    const sy = project.height / height;
    armHistory();
    set({ x: 0, y: 0, rotation: 0, scale: mode === 'fit' ? Math.min(sx, sy) : Math.max(sx, sy) });
  };
  const maxFade = clip.duration;
  return (
    <>
      <div className="insp-title">
        <span className={`dot clip-${clip.type}`} />
        <strong>{clip.type === 'text' ? 'Text' : clip.type === 'shape' ? (clip.shape!.kind === 'pulse' ? 'Click pulse' : 'Shape') : clip.type === 'zoom' ? 'Zoom' : clip.type === 'effect' ? EFFECT_LABEL[clip.effect!.kind] : media?.name ?? 'Clip'}</strong>
        <small>{formatTime(clip.start, project.fps)} · {clip.duration.toFixed(2)}s</small>
      </div>
      {clip.type === 'text' && <TextSection clip={clip} set={set} />}
      {clip.type === 'shape' && <ShapeSection clip={clip} set={set} />}
      {clip.type === 'zoom' && <ZoomSection clip={clip} set={set} />}
      {clip.type === 'effect' && <EffectSection clip={clip} set={set} />}
      {visual && (
        <Section title="Transform">
          <Row label="Position">
            <NumberField value={clip.x} onChange={(x) => set({ x })} suffix="X" />
            <NumberField value={clip.y} onChange={(y) => set({ y })} suffix="Y" />
          </Row>
          <Slider label="Scale" value={clip.scale} min={0.05} max={4} step={0.01} display={pct} reset={1} onChange={(scale) => set({ scale })} />
          <Slider label="Rotation" value={clip.rotation} min={-180} max={180} step={1} display={(v) => `${v}°`} reset={0} onChange={(rotation) => set({ rotation })} />
          <Slider label="Opacity" value={clip.opacity} min={0} max={1} step={0.01} display={pct} reset={1} onChange={(opacity) => set({ opacity })} />
          <div className="insp-buttons">
            <button className="btn small" onClick={() => fitTo('fit')}>Fit</button>
            <button className="btn small" onClick={() => fitTo('fill')}>Fill</button>
            <button className="btn small" onClick={() => { armHistory(); set({ x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }); }}>Reset</button>
          </div>
        </Section>
      )}
      {timed && (
        <Section title="Audio & speed">
          {media?.hasAudio ? (
            <Slider label="Volume" value={clip.volume} min={0} max={1} step={0.01} display={pct} reset={1} onChange={(volume) => set({ volume })} />
          ) : (
            <p className="insp-hint">This clip has no audio.</p>
          )}
          <Slider
            label="Speed"
            value={clip.speed}
            min={0.25}
            max={4}
            step={0.05}
            display={(v) => `${v.toFixed(2)}×`}
            reset={1}
            onChange={(speed) => liveEdit((p) => edit.setClipSpeed(p, clip.id, speed))}
          />
        </Section>
      )}
      {clip.type !== 'audio' && <AnimationSection clip={raw} project={project} />}
      {canTransition(clip) && <TransitionSection clip={clip} />}
      {clip.type !== 'zoom' && <Section title="Fades">
        <Slider label="Fade in" value={Math.min(clip.fadeIn, maxFade)} min={0} max={Math.min(5, maxFade)} step={0.1} display={secs} reset={0} onChange={(fadeIn) => set({ fadeIn })} />
        <Slider label="Fade out" value={Math.min(clip.fadeOut, maxFade)} min={0} max={Math.min(5, maxFade)} step={0.1} display={secs} reset={0} onChange={(fadeOut) => set({ fadeOut })} />
      </Section>}
      {(clip.type === 'video' || clip.type === 'image') && (
        <Section title="Colour">
          <Slider label="Brightness" value={clip.filters.brightness} min={0} max={2} step={0.01} display={pct} reset={1} onChange={(brightness) => setFilter({ brightness })} />
          <Slider label="Contrast" value={clip.filters.contrast} min={0} max={2} step={0.01} display={pct} reset={1} onChange={(contrast) => setFilter({ contrast })} />
          <Slider label="Saturation" value={clip.filters.saturation} min={0} max={2} step={0.01} display={pct} reset={1} onChange={(saturation) => setFilter({ saturation })} />
          <Slider label="Blur" value={clip.filters.blur} min={0} max={40} step={0.5} display={(v) => `${v}px`} reset={0} onChange={(blur) => setFilter({ blur })} />
        </Section>
      )}
    </>
  );
}

function Properties() {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const clip = selection.length === 1 ? edit.getClip(project, selection[0]) : undefined;
  return (
    <div className="insp-body">
      {clip ? (
        <ClipInspector key={clip.id} clip={clip} project={project} />
      ) : selection.length > 1 ? (
        <p className="insp-hint">{selection.length} clips selected. Press Delete to remove them, or select a single clip to edit it.</p>
      ) : (
        <ProjectSettings project={project} />
      )}
    </div>
  );
}

const TABS = [
  ['properties', 'Properties', SlidersHorizontal],
  ['assistant', 'Assistant', Sparkles],
  ['transcript', 'Transcript', Captions],
] as const;

/** Right-hand panel: clip properties, the AI assistant, and the transcript. */
export function Inspector() {
  const panel = useStore((s) => s.panel);
  const setPanel = useStore((s) => s.setPanel);
  return (
    <aside className="inspector" aria-label="Side panel">
      <div className="panel-tabs" role="tablist">
        {TABS.map(([id, label, Icon]) => (
          <button key={id} role="tab" aria-selected={panel === id} className={panel === id ? 'on' : ''} onClick={() => setPanel(id)}>
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>
      {panel === 'properties' && <Properties />}
      {panel === 'assistant' && <Assistant />}
      {panel === 'transcript' && <Transcript />}
    </aside>
  );
}
