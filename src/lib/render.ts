/** Frame compositor shared by the live preview and the exporter. */
import { Clip, Project } from '../types';
import { RenderItem, fadeFactor, getMedia, renderItems, resolveClip, zoomTransform } from './edit';

export type SourceLookup = (clip: Clip) => CanvasImageSource | null;

let measureCtx: OffscreenCanvasRenderingContext2D | null = null;
const measurer = () => (measureCtx ??= new OffscreenCanvas(8, 8).getContext('2d')!);

const fontOf = (clip: Clip) => {
  const t = clip.text!;
  return `${t.italic ? 'italic ' : ''}${t.bold ? '700' : '400'} ${t.fontSize}px ${t.fontFamily}`;
};

function textLayout(clip: Clip) {
  const t = clip.text!;
  const ctx = measurer();
  ctx.font = fontOf(clip);
  const lines = t.content.split('\n');
  const lineHeight = t.fontSize * 1.25;
  const pad = t.fontSize * 0.35;
  const textWidth = Math.max(1, ...lines.map((l) => ctx.measureText(l).width));
  return { lines, lineHeight, pad, textWidth, width: textWidth + pad * 2, height: lines.length * lineHeight + pad * 2 };
}

/** Unscaled size of a clip's content in canvas pixels. */
export function clipSize(clip: Clip, project: Project): { width: number; height: number } {
  if (clip.type === 'text' && clip.text) return textLayout(clip);
  if (clip.type === 'shape' && clip.shape) return { width: clip.shape.width, height: clip.shape.height };
  if (clip.type === 'effect' && clip.effect) return { width: clip.effect.width, height: clip.effect.height };
  if (clip.type === 'zoom') return { width: project.width, height: project.height };
  const media = getMedia(project, clip.mediaId);
  if (!media?.width || !media.height) return { width: project.width, height: project.height };
  const fit = Math.min(project.width / media.width, project.height / media.height);
  return { width: media.width * fit, height: media.height * fit };
}

function drawText(ctx: Ctx, clip: Clip) {
  const t = clip.text!;
  const { lines, lineHeight, pad, textWidth, width, height } = textLayout(clip);
  if (t.background) {
    ctx.fillStyle = t.background;
    ctx.beginPath();
    ctx.roundRect(-width / 2, -height / 2, width, height, t.fontSize * 0.2);
    ctx.fill();
  }
  ctx.font = fontOf(clip);
  ctx.textBaseline = 'middle';
  ctx.textAlign = t.align;
  const x = t.align === 'left' ? -textWidth / 2 : t.align === 'right' ? textWidth / 2 : 0;
  lines.forEach((line, i) => {
    const y = -height / 2 + pad + lineHeight * (i + 0.5);
    if (t.outlineWidth > 0) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = t.outlineWidth * 2;
      ctx.strokeStyle = t.outline;
      ctx.strokeText(line, x, y);
    }
    ctx.fillStyle = t.color;
    ctx.fillText(line, x, y);
  });
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
const PULSE_PERIOD = 0.9;

/** An expanding, fading ring that repeats: draws attention to a click or a spot. */
function drawPulse(ctx: Ctx, clip: Clip, localTime: number) {
  const s = clip.shape!;
  const phase = (localTime % PULSE_PERIOD) / PULSE_PERIOD;
  const alpha = ctx.globalAlpha;
  const rx = s.width / 2;
  const ry = s.height / 2;
  ctx.fillStyle = s.fill || s.stroke;
  ctx.globalAlpha = alpha * 0.9;
  ctx.beginPath();
  ctx.ellipse(0, 0, rx * 0.18, ry * 0.18, 0, 0, Math.PI * 2);
  ctx.fill();
  const grow = 0.25 + 0.75 * (1 - (1 - phase) ** 2);
  ctx.globalAlpha = alpha * (1 - phase);
  ctx.lineWidth = Math.max(1, s.strokeWidth);
  ctx.strokeStyle = s.stroke;
  ctx.beginPath();
  ctx.ellipse(0, 0, Math.max(1, rx * grow - ctx.lineWidth / 2), Math.max(1, ry * grow - ctx.lineWidth / 2), 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = alpha;
}

let scratch: OffscreenCanvas | null = null;

function regionPath(ctx: Ctx, clip: Clip) {
  const { region, width, height } = clip.effect!;
  if (region === 'ellipse') ctx.ellipse(0, 0, width / 2, height / 2, 0, 0, Math.PI * 2);
  else ctx.rect(-width / 2, -height / 2, width, height);
}

/**
 * Blur / pixelate / spotlight whatever has already been drawn beneath this clip.
 * Called with the clip's transform applied, so the region follows zooms above it.
 */
function drawEffect(ctx: Ctx, clip: Clip, alpha: number) {
  const fx = clip.effect!;
  if (fx.kind === 'spotlight') {
    ctx.beginPath();
    ctx.rect(-1e5, -1e5, 2e5, 2e5);
    regionPath(ctx, clip);
    ctx.fillStyle = `rgba(0, 0, 0, ${Math.min(1, fx.amount) * alpha})`;
    ctx.fill('evenodd');
    return;
  }
  const canvas = ctx.canvas;
  const m = ctx.getTransform();
  // Device pixels per canvas pixel, ignoring the clip's own scale so resizing the box doesn't change the strength.
  const k = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) / clip.scale;
  const amount = Math.max(0.5, fx.amount * k);
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => m.transformPoint({ x: (sx * fx.width) / 2, y: (sy * fx.height) / 2 }));
  const pad = fx.kind === 'blur' ? amount * 3 : 0;
  const x0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.x)) - pad));
  const y0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.y)) - pad));
  const x1 = Math.min(canvas.width, Math.ceil(Math.max(...corners.map((c) => c.x)) + pad));
  const y1 = Math.min(canvas.height, Math.ceil(Math.max(...corners.map((c) => c.y)) + pad));
  if (x1 <= x0 || y1 <= y0) return;
  ctx.beginPath();
  regionPath(ctx, clip);
  ctx.clip();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = alpha;
  if (fx.kind === 'blur') {
    ctx.filter = `blur(${amount}px)`;
    ctx.drawImage(canvas, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
  } else {
    const cols = Math.max(1, Math.ceil((x1 - x0) / amount));
    const rows = Math.max(1, Math.ceil((y1 - y0) / amount));
    scratch ??= new OffscreenCanvas(cols, rows);
    if (scratch.width < cols) scratch.width = cols;
    if (scratch.height < rows) scratch.height = rows;
    const sctx = scratch.getContext('2d')!;
    sctx.imageSmoothingEnabled = true;
    sctx.clearRect(0, 0, cols, rows);
    sctx.drawImage(canvas, x0, y0, cols * amount, rows * amount, 0, 0, cols, rows);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(scratch, 0, 0, cols, rows, x0, y0, cols * amount, rows * amount);
    ctx.imageSmoothingEnabled = true;
  }
}

/** Apply a transition's canvas-space transform / clipping; returns the opacity multiplier. */
function applyTransition(ctx: Ctx, project: Project, tr: NonNullable<RenderItem['transition']>): number {
  const { width: W, height: H } = project;
  const p = tr.progress;
  const entering = tr.role === 'in';
  switch (tr.type) {
    case 'dissolve':
      return entering ? p : 1;
    case 'wipe':
      if (entering) {
        ctx.beginPath();
        ctx.rect(0, 0, W * p, H);
        ctx.clip();
      }
      return 1;
    case 'push':
      ctx.translate(entering ? (1 - p) * W : -p * W, 0);
      return 1;
    case 'zoom': {
      const s = entering ? 0.85 + 0.15 * p : 1 + 0.4 * p;
      ctx.translate(W / 2, H / 2);
      ctx.scale(s, s);
      ctx.translate(-W / 2, -H / 2);
      return entering ? p : 1;
    }
    case 'dip':
      return entering ? Math.max(0, 2 * p - 1) : Math.max(0, 1 - 2 * p);
  }
}

function drawShape(ctx: Ctx, clip: Clip, localTime: number) {
  const s = clip.shape!;
  if (s.kind === 'pulse') return drawPulse(ctx, clip, localTime);
  if (s.kind === 'glow') {
    // A soft-edged highlight, used to make the mouse cursor easy to follow.
    const r = Math.max(s.width, s.height) / 2;
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    const colour = s.fill || s.stroke;
    gradient.addColorStop(0, colour);
    gradient.addColorStop(0.6, colour);
    gradient.addColorStop(1, 'transparent');
    ctx.save();
    ctx.scale(s.width / (2 * r), s.height / (2 * r));
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  const w = s.width;
  const h = s.height;
  ctx.beginPath();
  if (s.kind === 'rect') {
    const inset = s.strokeWidth / 2;
    ctx.roundRect(-w / 2 + inset, -h / 2 + inset, w - inset * 2, h - inset * 2, Math.max(0, s.radius));
  } else if (s.kind === 'ellipse') {
    ctx.ellipse(0, 0, Math.max(1, w / 2 - s.strokeWidth / 2), Math.max(1, h / 2 - s.strokeWidth / 2), 0, 0, Math.PI * 2);
  } else {
    const head = Math.min(w * 0.45, h);
    const shaft = h * 0.22;
    ctx.moveTo(-w / 2, -shaft);
    ctx.lineTo(w / 2 - head, -shaft);
    ctx.lineTo(w / 2 - head, -h / 2);
    ctx.lineTo(w / 2, 0);
    ctx.lineTo(w / 2 - head, h / 2);
    ctx.lineTo(w / 2 - head, shaft);
    ctx.lineTo(-w / 2, shaft);
    ctx.closePath();
  }
  if (s.fill) {
    ctx.fillStyle = s.fill;
    ctx.fill();
  }
  if (s.strokeWidth > 0 && s.stroke) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = s.strokeWidth;
    ctx.strokeStyle = s.stroke;
    ctx.stroke();
  }
}

function filterString(clip: Clip): string {
  const f = clip.filters;
  const parts: string[] = [];
  if (f.brightness !== 1) parts.push(`brightness(${f.brightness})`);
  if (f.contrast !== 1) parts.push(`contrast(${f.contrast})`);
  if (f.saturation !== 1) parts.push(`saturate(${f.saturation})`);
  if (f.blur > 0) parts.push(`blur(${f.blur}px)`);
  return parts.join(' ') || 'none';
}

export interface DrawOptions {
  /** Ignore this zoom clip, so its target area can be edited against the un-zoomed frame. */
  bypassZoomId?: string;
  /** Draw only what lies on tracks beneath this one (what a clip on this track sits on top of). */
  belowTrackId?: string;
}

/**
 * Draw the project at `time`. The context is expected to be `project.width` x
 * `project.height` in user space (apply a scale transform first for other output sizes).
 */
export function drawFrame(ctx: Ctx, project: Project, time: number, lookup: SourceLookup, options: DrawOptions = {}) {
  ctx.save();
  ctx.fillStyle = project.background;
  ctx.fillRect(0, 0, project.width, project.height);
  ctx.beginPath();
  ctx.rect(0, 0, project.width, project.height);
  ctx.clip();
  const order = new Map(project.tracks.map((t, i) => [t.id, i]));
  const limit = options.belowTrackId ? order.get(options.belowTrackId) ?? -1 : -1;
  for (const item of renderItems(project, time)) {
    if (order.get(item.clip.trackId)! <= limit) continue;
    if (item.clip.type === 'zoom') continue; // applied to the layers beneath via zoomTransform
    // Apply keyframed motion. A held clip stays where its animation left it.
    const clip = resolveClip(item.clip, item.clip.start + item.localTime);
    ctx.save();
    const view = zoomTransform(project, time, clip.trackId, options.bypassZoomId, options.belowTrackId);
    ctx.translate(view.tx, view.ty);
    ctx.scale(view.k, view.k);
    let alpha = clip.opacity * (item.held ? 1 : fadeFactor(clip, time));
    if (item.transition) alpha *= applyTransition(ctx, project, item.transition);
    if (alpha > 0) {
      ctx.translate(project.width / 2 + clip.x, project.height / 2 + clip.y);
      ctx.rotate((clip.rotation * Math.PI) / 180);
      ctx.scale(clip.scale, clip.scale);
      if (clip.type === 'effect' && clip.effect) drawEffect(ctx, clip, alpha);
      else {
        ctx.globalAlpha = alpha;
        ctx.filter = filterString(clip);
        if (clip.type === 'text' && clip.text) drawText(ctx, clip);
        else if (clip.type === 'shape' && clip.shape) drawShape(ctx, clip, item.localTime);
        else {
          const source = lookup(item.clip);
          if (source) {
            const { width, height } = clipSize(clip, project);
            try {
              ctx.drawImage(source, -width / 2, -height / 2, width, height);
            } catch {
              // Source not decodable yet; skip this frame.
            }
          }
        }
      }
    }
    ctx.restore();
  }
  ctx.restore();
}
