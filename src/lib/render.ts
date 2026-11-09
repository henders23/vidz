/** Frame compositor shared by the live preview and the exporter. */
import { Clip, Project } from '../types';
import { fadeFactor, getMedia, visibleClips } from './edit';

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
  const media = getMedia(project, clip.mediaId);
  if (!media?.width || !media.height) return { width: project.width, height: project.height };
  const fit = Math.min(project.width / media.width, project.height / media.height);
  return { width: media.width * fit, height: media.height * fit };
}

function drawText(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, clip: Clip) {
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

function drawShape(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, clip: Clip) {
  const s = clip.shape!;
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

/**
 * Draw the project at `time`. The context is expected to be `project.width` x
 * `project.height` in user space (apply a scale transform first for other output sizes).
 */
export function drawFrame(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  project: Project,
  time: number,
  lookup: SourceLookup,
) {
  ctx.save();
  ctx.fillStyle = project.background;
  ctx.fillRect(0, 0, project.width, project.height);
  ctx.beginPath();
  ctx.rect(0, 0, project.width, project.height);
  ctx.clip();
  for (const clip of visibleClips(project, time)) {
    const alpha = clip.opacity * fadeFactor(clip, time);
    if (alpha <= 0) continue;
    ctx.save();
    ctx.translate(project.width / 2 + clip.x, project.height / 2 + clip.y);
    ctx.rotate((clip.rotation * Math.PI) / 180);
    ctx.scale(clip.scale, clip.scale);
    ctx.globalAlpha = alpha;
    ctx.filter = filterString(clip);
    if (clip.type === 'text' && clip.text) drawText(ctx, clip);
    else if (clip.type === 'shape' && clip.shape) drawShape(ctx, clip);
    else {
      const source = lookup(clip);
      if (source) {
        const { width, height } = clipSize(clip, project);
        try {
          ctx.drawImage(source, -width / 2, -height / 2, width, height);
        } catch {
          // Source not decodable yet; skip this frame.
        }
      }
    }
    ctx.restore();
  }
  ctx.restore();
}
