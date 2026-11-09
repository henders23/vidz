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
  /** Size of the target relative to when tracking started (1 = unchanged). */
  scale: number;
}

export interface TrackOptions {
  /** Also follow the target getting bigger or smaller (moving towards or away from the camera). */
  followSize?: boolean;
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

const MAX_SAMPLES = 1024;
const LOST_BELOW = 0.45;
/** While the target still looks this much like it did at the start, trust that original picture. */
const ANCHOR_ABOVE = 0.6;
const ADAPT_ABOVE = 0.75;
const ADAPT_RATE = 0.15;
const SIZE_STEP = 1.04;

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
  const scores = new Float32Array(size * size).fill(NaN);
  const patch = new Float32Array(template.samples.length);
  let best = -1;
  let bx = 0;
  let by = 0;
  const score = (dx: number, dy: number): number => {
    const index = (dy + radius) * size + dx + radius;
    if (Number.isNaN(scores[index])) {
      sample(gray, cx + dx, cy + dy, template, patch);
      scores[index] = correlation(template.samples, patch);
    }
    return scores[index];
  };
  const consider = (dx: number, dy: number) => {
    if (Math.abs(dx) > radius || Math.abs(dy) > radius) return;
    const value = score(dx, dy);
    if (value > best) {
      best = value;
      bx = dx;
      by = dy;
    }
  };
  // Coarse pass over every other position, then a fine pass around the best one found.
  for (let dy = -radius; dy <= radius; dy += 2) for (let dx = -radius; dx <= radius; dx += 2) consider(dx, dy);
  const coarseX = bx;
  const coarseY = by;
  for (let dy = coarseY - 2; dy <= coarseY + 2; dy++) for (let dx = coarseX - 2; dx <= coarseX + 2; dx++) consider(dx, dy);
  // Fit a parabola through the best score and its neighbours for a position between pixels.
  const at = (dx: number, dy: number) => (Math.abs(dx) > radius || Math.abs(dy) > radius ? best : score(dx, dy));
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

/** The same remembered picture, sampled as if the target were `scale` times its original size. */
const scaled = (t: Template, scale: number): Template => ({ ...t, stepX: t.stepX * scale, stepY: t.stepY * scale });

/**
 * Follow the contents of a box through `times`. `frameAt` supplies each frame;
 * the box starts centred on (x, y) at `times[0]`.
 */
export async function track(
  frameAt: (time: number) => Promise<Gray>,
  times: number[],
  start: { x: number; y: number; width: number; height: number },
  options: TrackOptions = {},
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<TrackResult> {
  const first = await frameAt(times[0]);
  // Two memories of the target: how it looked at the start (never changes, so it cannot drift)
  // and how it has looked recently (adapts as the target turns or the light changes).
  const anchor = makeTemplate(first, start.x, start.y, start.width, start.height);
  const recent: Template = { ...anchor, samples: anchor.samples.slice() };
  const radius = Math.round(Math.min(48, Math.max(16, Math.max(start.width, start.height) * 0.75)));
  const points: TrackPoint[] = [{ time: times[0], x: start.x, y: start.y, scale: 1 }];
  const patch = new Float32Array(anchor.samples.length);
  let x = start.x;
  let y = start.y;
  let vx = 0;
  let vy = 0;
  let scale = 1;
  let sizeTrend = 0;

  const find = (gray: Gray, cx: number, cy: number) => {
    let found = match(gray, scaled(anchor, scale), cx, cy, radius);
    if (found.score < ANCHOR_ABOVE) {
      const fallback = match(gray, scaled(recent, scale), cx, cy, radius);
      if (fallback.score > found.score) found = fallback;
    }
    return found;
  };
  for (let i = 1; i < times.length; i++) {
    if (signal?.aborted) throw new DOMException('Tracking cancelled', 'AbortError');
    const gray = await frameAt(times[i]);
    onProgress?.(i / (times.length - 1));
    // Look around where the target would be if it kept moving as it has been.
    const found = find(gray, Math.round(x + vx), Math.round(y + vy));
    if (found.score < LOST_BELOW) return { points, lostAt: times[i] };
    vx = found.x - x;
    vy = found.y - y;
    x = found.x;
    y = found.y;

    if (options.followSize) {
      // Would the target match better a little bigger or smaller? Try a few sizes (re-centring
      // for each) and only change on a clear win, so a steady target does not jitter.
      const reference = found.score >= ANCHOR_ABOVE ? anchor : recent;
      // Compare like with like: the current size gets the same local re-centring as the others.
      const same = match(gray, scaled(reference, scale), Math.round(x), Math.round(y), 2).score;
      let best = { score: same, scale, x, y, direction: 0 };
      for (const steps of [-2, -1, 1, 2]) {
        const size = Math.min(4, Math.max(0.25, scale * SIZE_STEP ** steps));
        const m = match(gray, scaled(reference, size), Math.round(x), Math.round(y), 2);
        if (m.score > best.score) best = { score: m.score, scale: size, x: m.x, y: m.y, direction: Math.sign(steps) };
      }
      const direction = best.score > same + 0.02 ? best.direction : 0;
      // Act only when two frames in a row agree, so noise in a single frame is ignored.
      if (direction !== 0 && direction === sizeTrend) ({ scale, x, y } = best);
      sizeTrend = direction;
    }

    points.push({ time: times[i], x, y, scale });
    if (found.score > ADAPT_ABOVE) {
      sample(gray, Math.round(x), Math.round(y), scaled(recent, scale), patch);
      for (let n = 0; n < patch.length; n++) recent.samples[n] += (patch[n] - recent.samples[n]) * ADAPT_RATE;
    }
  }
  return { points };
}

const CHANGED = 18;

/**
 * Follow a mouse cursor through a screen recording by watching what moves. A
 * cursor's picture cannot be matched directly, because whatever is behind it
 * keeps changing; but on a mostly still screen, the cursor is the small thing
 * that disappears from one place and appears in another.
 *
 * `start` is the cursor's centre and rough size at `times[0]`. Changes that are
 * not the cursor leaving its spot (typing, a blinking caret, a video playing)
 * are ignored, and the position simply holds.
 */
export async function trackCursor(
  frameAt: (time: number) => Promise<Gray>,
  times: number[],
  start: { x: number; y: number; size: number },
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<TrackResult> {
  const size = start.size;
  const reach = size * 0.8; // half-width of the area the cursor currently occupies
  const cell = Math.max(2, Math.round(size / 2));
  let previous = await frameAt(times[0]);
  let x = start.x;
  let y = start.y;
  const points: TrackPoint[] = [{ time: times[0], x, y, scale: 1 }];

  for (let i = 1; i < times.length; i++) {
    if (signal?.aborted) throw new DOMException('Tracking cancelled', 'AbortError');
    const gray = await frameAt(times[i]);
    onProgress?.(i / (times.length - 1));
    const { width, height } = gray;
    const cols = Math.ceil(width / cell);
    const rows = Math.ceil(height / cell);
    const away = new Uint16Array(cols * rows); // changed pixels per cell, outside the cursor's current spot
    let total = 0;
    let here = 0;
    let minX = width, maxX = -1, minY = height, maxY = -1;
    for (let py = 0; py < height; py++) {
      const row = py * width;
      for (let px = 0; px < width; px++) {
        if (Math.abs(gray.data[row + px] - previous.data[row + px]) <= CHANGED) continue;
        total++;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        if (Math.abs(px - x) <= reach && Math.abs(py - y) <= reach) here++;
        else away[Math.floor(py / cell) * cols + Math.floor(px / cell)]++;
      }
    }
    const elsewhere = total - here;
    // Nothing moved, the whole screen changed (scrolling, a new window), or something
    // changed while the cursor stayed put: in each case the cursor has not gone anywhere.
    const moved = total > 0 && here > 0 && total < 40 * size * size;
    if (moved && elsewhere < 0.2 * total) {
      // A short hop: the changed area spans the old and new positions, so its middle is halfway.
      const nx = minX + maxX + 1 - x;
      const ny = minY + maxY + 1 - y;
      if (Math.hypot(nx - x, ny - y) <= 2 * size) {
        x = nx;
        y = ny;
      }
    } else if (moved) {
      // A longer move: find the cursor-sized block where most of the remaining change is.
      let best = 0;
      let bc = 0;
      let br = 0;
      for (let r = 0; r < rows - 1; r++) {
        for (let c = 0; c < cols - 1; c++) {
          const n = away[r * cols + c] + away[r * cols + c + 1] + away[(r + 1) * cols + c] + away[(r + 1) * cols + c + 1];
          if (n > best) {
            best = n;
            bc = c;
            br = r;
          }
        }
      }
      if (best >= 0.5 * elsewhere) {
        // Measure the changed pixels in and just around that block.
        const x0 = Math.max(0, (bc - 1) * cell);
        const x1 = Math.min(width, (bc + 3) * cell);
        const y0 = Math.max(0, (br - 1) * cell);
        const y1 = Math.min(height, (br + 3) * cell);
        let bx0 = x1, bx1 = -1, by0 = y1, by1 = -1;
        for (let py = y0; py < y1; py++) {
          for (let px = x0; px < x1; px++) {
            if (Math.abs(px - x) <= reach && Math.abs(py - y) <= reach) continue;
            if (Math.abs(gray.data[py * width + px] - previous.data[py * width + px]) <= CHANGED) continue;
            if (px < bx0) bx0 = px;
            if (px > bx1) bx1 = px;
            if (py < by0) by0 = py;
            if (py > by1) by1 = py;
          }
        }
        // Ignore specks much smaller than a cursor (a typed character, a caret).
        if (bx1 >= 0 && (bx1 - bx0 >= 0.3 * size || by1 - by0 >= 0.3 * size)) {
          x = (bx0 + bx1 + 1) / 2;
          y = (by0 + by1 + 1) / 2;
        }
      }
    }
    points.push({ time: times[i], x, y, scale: 1 });
    previous = gray;
  }
  return { points };
}

/**
 * Drop points that lie on a straight, constant-speed path between their neighbours
 * (Ramer-Douglas-Peucker). `size` is the target's size in pixels, so that a change
 * in scale counts as distance too.
 */
export function simplify(points: TrackPoint[], tolerance: number, size = 0): TrackPoint[] {
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
      const d = Math.hypot(
        points[i].x - (pa.x + (pb.x - pa.x) * u),
        points[i].y - (pa.y + (pb.y - pa.y) * u),
        (points[i].scale - (pa.scale + (pb.scale - pa.scale) * u)) * size,
      );
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
