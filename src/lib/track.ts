/**
 * Motion tracking by template matching: remember what the picture looks like
 * inside a box, then find the best-matching spot in each following frame.
 * Works on small greyscale frames, so it is fast enough to run in the browser.
 */

export interface Gray {
  data: Float32Array;
  width: number;
  height: number;
}

export interface TrackPoint {
  time: number;
  /** Box centre, in the greyscale frame's pixels. */
  x: number;
  y: number;
}

export interface TrackResult {
  points: TrackPoint[];
  /** Set when the target could no longer be found; tracking stopped just before this time. */
  lostAt?: number;
}

interface Template {
  samples: Float32Array;
  cols: number;
  rows: number;
  /** Distance between samples, in frame pixels. */
  stepX: number;
  stepY: number;
}

const MAX_SAMPLES = 1600;
const LOST_BELOW = 0.45;
/** While the target still looks this much like it did at the start, trust that original picture. */
const ANCHOR_ABOVE = 0.6;
const ADAPT_ABOVE = 0.75;
const ADAPT_RATE = 0.15;

export function toGray(image: { data: Uint8ClampedArray; width: number; height: number }): Gray {
  const data = new Float32Array(image.width * image.height);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    data[i] = 0.299 * image.data[j] + 0.587 * image.data[j + 1] + 0.114 * image.data[j + 2];
  }
  return { data, width: image.width, height: image.height };
}

/** Read a grid of samples centred on (cx, cy). Samples outside the frame repeat the edge pixel. */
function sample(gray: Gray, cx: number, cy: number, t: Pick<Template, 'cols' | 'rows' | 'stepX' | 'stepY'>, out: Float32Array) {
  const x0 = cx - ((t.cols - 1) * t.stepX) / 2;
  const y0 = cy - ((t.rows - 1) * t.stepY) / 2;
  let n = 0;
  for (let r = 0; r < t.rows; r++) {
    const y = Math.min(gray.height - 1, Math.max(0, Math.round(y0 + r * t.stepY)));
    const row = y * gray.width;
    for (let c = 0; c < t.cols; c++) {
      const x = Math.min(gray.width - 1, Math.max(0, Math.round(x0 + c * t.stepX)));
      out[n++] = gray.data[row + x];
    }
  }
}

function makeTemplate(gray: Gray, cx: number, cy: number, width: number, height: number): Template {
  // Use at most MAX_SAMPLES evenly spread samples so big boxes cost the same as small ones.
  const shrink = Math.max(1, Math.sqrt((width * height) / MAX_SAMPLES));
  const cols = Math.max(4, Math.round(width / shrink));
  const rows = Math.max(4, Math.round(height / shrink));
  const template: Template = { samples: new Float32Array(cols * rows), cols, rows, stepX: width / cols, stepY: height / rows };
  sample(gray, cx, cy, template, template.samples);
  return template;
}

/** Zero-mean normalised cross-correlation: 1 = identical apart from brightness/contrast, 0 = unrelated. */
function correlation(a: Float32Array, b: Float32Array): number {
  const n = a.length;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i];
    sb += b[i];
  }
  const ma = sa / n;
  const mb = sb / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  // A featureless patch (no variation) cannot be matched to anything.
  if (da < n || db < n) return 0;
  return num / Math.sqrt(da * db);
}

/** Best match for the template within `radius` pixels of (cx, cy), refined to sub-pixel precision. */
export function match(gray: Gray, template: Template, cx: number, cy: number, radius: number): { x: number; y: number; score: number } {
  const size = 2 * radius + 1;
  const scores = new Float32Array(size * size).fill(-1);
  const patch = new Float32Array(template.samples.length);
  let best = -1;
  let bx = 0;
  let by = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      sample(gray, cx + dx, cy + dy, template, patch);
      const score = correlation(template.samples, patch);
      scores[(dy + radius) * size + dx + radius] = score;
      if (score > best) {
        best = score;
        bx = dx;
        by = dy;
      }
    }
  }
  // Fit a parabola through the best score and its neighbours for a position between pixels.
  const at = (dx: number, dy: number) =>
    Math.abs(dx) > radius || Math.abs(dy) > radius ? best : scores[(dy + radius) * size + dx + radius];
  const refine = (lo: number, hi: number) => {
    const curve = lo - 2 * best + hi;
    return curve < -1e-6 ? Math.max(-0.5, Math.min(0.5, (0.5 * (lo - hi)) / curve)) : 0;
  };
  return {
    x: cx + bx + refine(at(bx - 1, by), at(bx + 1, by)),
    y: cy + by + refine(at(bx, by - 1), at(bx, by + 1)),
    score: best,
  };
}

/**
 * Follow the contents of a box through `times`. `frameAt` supplies each frame;
 * the box starts centred on (x, y) at `times[0]`.
 */
export async function track(
  frameAt: (time: number) => Promise<Gray>,
  times: number[],
  start: { x: number; y: number; width: number; height: number },
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<TrackResult> {
  const first = await frameAt(times[0]);
  // Two memories of the target: how it looked at the start (never changes, so it cannot drift)
  // and how it has looked recently (adapts as the target turns or the light changes).
  const anchor = makeTemplate(first, start.x, start.y, start.width, start.height);
  const recent: Template = { ...anchor, samples: anchor.samples.slice() };
  const radius = Math.round(Math.min(48, Math.max(16, Math.max(start.width, start.height) * 0.75)));
  const points: TrackPoint[] = [{ time: times[0], x: start.x, y: start.y }];
  const patch = new Float32Array(anchor.samples.length);
  let x = start.x;
  let y = start.y;
  let vx = 0;
  let vy = 0;
  for (let i = 1; i < times.length; i++) {
    if (signal?.aborted) throw new DOMException('Tracking cancelled', 'AbortError');
    const gray = await frameAt(times[i]);
    // Look around where the target would be if it kept moving as it has been.
    const px = Math.round(x + vx);
    const py = Math.round(y + vy);
    let found = match(gray, anchor, px, py, radius);
    if (found.score < ANCHOR_ABOVE) {
      const fallback = match(gray, recent, px, py, radius);
      if (fallback.score > found.score) found = fallback;
    }
    if (found.score < LOST_BELOW) return { points, lostAt: times[i] };
    vx = found.x - x;
    vy = found.y - y;
    x = found.x;
    y = found.y;
    points.push({ time: times[i], x, y });
    if (found.score > ADAPT_ABOVE) {
      sample(gray, Math.round(x), Math.round(y), recent, patch);
      for (let n = 0; n < patch.length; n++) recent.samples[n] += (patch[n] - recent.samples[n]) * ADAPT_RATE;
    }
    onProgress?.(i / (times.length - 1));
  }
  return { points };
}

/** Drop points that lie on a straight, constant-speed path between their neighbours (Ramer-Douglas-Peucker). */
export function simplify(points: TrackPoint[], tolerance: number): TrackPoint[] {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const pa = points[a];
    const pb = points[b];
    let worst = 0;
    let index = -1;
    for (let i = a + 1; i < b; i++) {
      const u = (points[i].time - pa.time) / (pb.time - pa.time);
      const d = Math.hypot(points[i].x - (pa.x + (pb.x - pa.x) * u), points[i].y - (pa.y + (pb.y - pa.y) * u));
      if (d > worst) {
        worst = d;
        index = i;
      }
    }
    if (worst > tolerance && index > 0) {
      keep[index] = 1;
      stack.push([a, index], [index, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}
