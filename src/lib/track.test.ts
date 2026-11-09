import { describe, expect, it } from 'vitest';
import { Gray, simplify, track } from './track';

const W = 320;
const H = 180;

/** A noisy background with a distinctive textured patch centred on (cx, cy). */
function frame(cx: number, cy: number, brightness = 0): Gray {
  const data = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const noise = ((x * 73 + y * 151) % 31) * 2;
      const dx = x - cx;
      const dy = y - cy;
      const inside = Math.abs(dx) < 14 && Math.abs(dy) < 14;
      data[y * W + x] = brightness + (inside ? 120 + 60 * Math.sin(dx * 0.7) * Math.cos(dy * 0.5) + (dx > 0 ? 40 : 0) : noise);
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
    await expect(track(async (t) => frame(path(t).x, path(t).y), times, { ...path(0), width: 32, height: 32 }, undefined, abort.signal)).rejects.toThrow('cancelled');
  });

  it('simplifies a straight constant-speed path to its end points', () => {
    const straight = times.map((t) => ({ time: t, x: 10 + 50 * t, y: 20 }));
    expect(simplify(straight, 0.5)).toHaveLength(2);
    const bent = times.map((t) => ({ time: t, x: 10 + 50 * t, y: t < 1 ? 20 : 20 + 80 * (t - 1) }));
    const kept = simplify(bent, 0.5);
    expect(kept).toHaveLength(3);
    expect(kept[1].time).toBeCloseTo(1);
  });
});
