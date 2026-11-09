import { describe, expect, it } from 'vitest';
import { Gray, simplify, track } from './track';

const W = 320;
const H = 180;

/** A noisy background with a distinctive textured patch centred on (cx, cy). */
function frame(cx: number, cy: number, brightness = 0, size = 1): Gray {
  const data = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const noise = ((x * 73 + y * 151) % 31) * 2;
      const dx = (x - cx) / size;
      const dy = (y - cy) / size;
      const inside = Math.abs(dx) < 14 && Math.abs(dy) < 14;
      // Broad shapes plus some fine detail, like a real object.
      const detail = 120 + 70 * Math.sin(dx * 0.22 + 1) * Math.cos(dy * 0.17) + 25 * Math.sin(dx * 0.7) * Math.cos(dy * 0.5) + (dx > 0 ? 40 : 0);
      data[y * W + x] = brightness + (inside ? detail : noise);
    }
  }
  return { data, width: W, height: H };
}

describe('motion tracking', () => {
  const times = Array.from({ length: 31 }, (_, i) => i / 15);
  const path = (t: number) => ({ x: 60 + 90 * t, y: 90 + 30 * Math.sin(t * 3) });

  it('follows a moving target to within a pixel', async () => {
    const result = await track(async (t) => frame(path(t).x, path(t).y, t * 20), times, { ...path(0), width: 32, height: 32 });
    expect(result.lostAt).toBeUndefined();
    expect(result.points).toHaveLength(times.length);
    for (const pt of result.points) {
      expect(Math.abs(pt.x - path(pt.time).x)).toBeLessThan(1);
      expect(Math.abs(pt.y - path(pt.time).y)).toBeLessThan(1);
    }
  });

  it('reports where the target was lost', async () => {
    const result = await track(async (t) => (t < 1 ? frame(path(t).x, path(t).y) : frame(-100, -100)), times, { ...path(0), width: 32, height: 32 });
    expect(result.lostAt).toBeCloseTo(1);
    expect(result.points[result.points.length - 1].time).toBeLessThan(1);
  });

  it('refuses to follow a featureless area', async () => {
    const flat: Gray = { data: new Float32Array(W * H).fill(80), width: W, height: H };
    const result = await track(async () => flat, times, { x: 100, y: 90, width: 32, height: 32 });
    expect(result.points).toHaveLength(1);
    expect(result.lostAt).toBeCloseTo(times[1]);
  });

  it('can be cancelled', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(track(async (t) => frame(path(t).x, path(t).y), times, { ...path(0), width: 32, height: 32 }, {}, undefined, abort.signal)).rejects.toThrow('cancelled');
  });

  it('simplifies a straight constant-speed path to its end points', () => {
    const straight = times.map((t) => ({ time: t, x: 10 + 50 * t, y: 20, scale: 1 }));
    expect(simplify(straight, 0.5)).toHaveLength(2);
    const bent = times.map((t) => ({ time: t, x: 10 + 50 * t, y: t < 1 ? 20 : 20 + 80 * (t - 1), scale: 1 }));
    const kept = simplify(bent, 0.5);
    expect(kept).toHaveLength(3);
    expect(kept[1].time).toBeCloseTo(1);
  });

  it('follows a target that grows', async () => {
    const size = (t: number) => 1 + 0.4 * t; // 1x -> 1.8x over two seconds
    const result = await track(async (t) => frame(path(t).x, 90, 0, size(t)), times, { x: path(0).x, y: 90, width: 32, height: 32 }, { followSize: true });
    expect(result.lostAt).toBeUndefined();
    const last = result.points[result.points.length - 1];
    expect(last.scale).toBeGreaterThan(1.6);
    expect(last.scale).toBeLessThan(2);
    expect(Math.abs(last.x - path(last.time).x)).toBeLessThan(2);
    // A constant-size target stays within one size step of where it started.
    const steady = await track(async (t) => frame(path(t).x, path(t).y), times, { ...path(0), width: 32, height: 32 }, { followSize: true });
    expect(steady.points.every((p) => Math.abs(p.scale - 1) < 0.05)).toBe(true);
  });

  it('follows a cursor across a changing background by its motion', async () => {
    // A busy static "screen" with a small arrow-like cursor drawn on top.
    const screen = (cx: number, cy: number, typed = 0): Gray => {
      const data = new Float32Array(W * H);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          let v = (Math.floor(x / 9) * 37 + Math.floor(y / 7) * 91) % 200;
          if (typed && x >= 20 && x < 20 + typed && y >= 20 && y < 24) v = 255; // text being typed far away
          const dx = x - cx;
          const dy = y - cy;
          if (Math.abs(dx) <= 6 && Math.abs(dy) <= 8) v = Math.abs(dx) > 4 || Math.abs(dy) > 6 ? 0 : 255;
          data[y * W + x] = v;
        }
      }
      return { data, width: W, height: H };
    };
    // Glide, hold still while "typing" happens elsewhere, then jump across the screen and glide again.
    const where = (t: number) => (t < 0.8 ? { x: 60 + 150 * t, y: 60 + 40 * t } : t < 1.2 ? { x: 180, y: 92 } : { x: 260 - 60 * (t - 1.2), y: 150 - 20 * (t - 1.2) });
    const { trackCursor } = await import('./track');
    const result = await trackCursor(async (t) => screen(Math.round(where(t).x), Math.round(where(t).y), t >= 0.8 && t < 1.2 ? Math.round((t - 0.8) * 40) : 0), times, { ...where(0), size: 16 });
    expect(result.points).toHaveLength(times.length);
    for (const pt of result.points) {
      expect(Math.hypot(pt.x - where(pt.time).x, pt.y - where(pt.time).y)).toBeLessThan(6);
    }
  });
});
