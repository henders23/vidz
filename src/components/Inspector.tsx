import { AlignCenter, AlignLeft, AlignRight, Bold, Italic } from 'lucide-react';
import { Clip, Filters, Project, ShapeProps, TextProps } from '../types';
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
    <Section title="Shape">
      <Row label="Size">
        <NumberField value={sh.width} min={2} onChange={(v) => setShape({ width: Math.max(2, v) })} />
        <span className="times">×</span>
        <NumberField value={sh.height} min={2} onChange={(v) => setShape({ height: Math.max(2, v) })} />
      </Row>
      <Row label="Fill"><ColorField optional value={sh.fill} onChange={(fill) => setShape({ fill })} /></Row>
      <Row label="Border">
        <ColorField value={sh.stroke} onChange={(stroke) => setShape({ stroke })} />
        <NumberField value={sh.strokeWidth} min={0} max={200} onChange={(v) => setShape({ strokeWidth: Math.max(0, v) })} suffix="px" />
      </Row>
      {sh.kind === 'rect' && (
        <Row label="Corners"><NumberField value={sh.radius} min={0} onChange={(v) => setShape({ radius: Math.max(0, v) })} suffix="px" /></Row>
      )}
    </Section>
  );
}

function ClipInspector({ clip, project }: { clip: Clip; project: Project }) {
  const set = (patch: Partial<Clip>) => liveEdit((p) => edit.updateClip(p, clip.id, patch));
  const setFilter = (patch: Partial<Filters>) => set({ filters: { ...clip.filters, ...patch } });
  const visual = clip.type !== 'audio';
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
        <strong>{clip.type === 'text' ? 'Text' : clip.type === 'shape' ? 'Shape' : media?.name ?? 'Clip'}</strong>
        <small>{formatTime(clip.start, project.fps)} · {clip.duration.toFixed(2)}s</small>
      </div>
      {clip.type === 'text' && <TextSection clip={clip} set={set} />}
      {clip.type === 'shape' && <ShapeSection clip={clip} set={set} />}
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
      <Section title="Fades">
        <Slider label="Fade in" value={Math.min(clip.fadeIn, maxFade)} min={0} max={Math.min(5, maxFade)} step={0.1} display={secs} reset={0} onChange={(fadeIn) => set({ fadeIn })} />
        <Slider label="Fade out" value={Math.min(clip.fadeOut, maxFade)} min={0} max={Math.min(5, maxFade)} step={0.1} display={secs} reset={0} onChange={(fadeOut) => set({ fadeOut })} />
      </Section>
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

export function Inspector() {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const clip = selection.length === 1 ? edit.getClip(project, selection[0]) : undefined;
  return (
    <aside className="inspector" aria-label="Properties">
      <div className="panel-title">Properties</div>
      <div className="insp-body">
        {clip ? (
          <ClipInspector key={clip.id} clip={clip} project={project} />
        ) : selection.length > 1 ? (
          <p className="insp-hint">{selection.length} clips selected. Press Delete to remove them, or select a single clip to edit it.</p>
        ) : (
          <ProjectSettings project={project} />
        )}
      </div>
    </aside>
  );
}
