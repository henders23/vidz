/**
 * Working out who is speaking. Each stretch of speech gets a "voiceprint" (an
 * embedding vector from a speaker-recognition model); stretches whose
 * voiceprints are alike are the same speaker.
 */
import { TimeRange, Word } from '../types';

/** Split a transcript into stretches of continuous speech, each long enough to recognise a voice from. */
export function speechSegments(words: Word[]): (TimeRange & { from: number; to: number })[] {
  const segments: (TimeRange & { from: number; to: number })[] = [];
  let from = 0;
  for (let i = 0; i < words.length; i++) {
    const next = words[i + 1];
    const length = words[i].end - words[from].start;
    const pause = next ? next.start - words[i].end : Infinity;
    const sentenceEnd = /[.!?]$/.test(words[i].text);
    if (!next || pause > 0.45 || (sentenceEnd && length >= 1.5) || length > 8) {
      segments.push({ start: words[from].start, end: words[i].end, from, to: i });
      from = i + 1;
    }
  }
  return segments;
}

const dot = (a: Float32Array, b: Float32Array) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
};

function normalise(v: Float32Array): Float32Array {
  const length = Math.sqrt(dot(v, v)) || 1;
  return v.map((x) => x / length);
}

/**
 * Group voiceprints into speakers. Returns a speaker number (from 1, in order
 * of first appearance) for each embedding. `weights` are the segment lengths:
 * long segments give more reliable voiceprints, so they are placed first and
 * count for more.
 */
export function clusterSpeakers(embeddings: Float32Array[], weights: number[], threshold = 0.5, maxSpeakers = 8): number[] {
  const vectors = embeddings.map(normalise);
  const order = vectors.map((_, i) => i).sort((a, b) => weights[b] - weights[a]);
  const centroids: { sum: Float32Array; members: number[] }[] = [];
  const assigned = new Array<number>(vectors.length).fill(-1);
  for (const i of order) {
    let best = -1;
    let bestScore = -Infinity;
    centroids.forEach((c, index) => {
      const score = dot(normalise(c.sum), vectors[i]);
      if (score > bestScore) {
        bestScore = score;
        best = index;
      }
    });
    if (best === -1 || (bestScore < threshold && centroids.length < maxSpeakers)) {
      centroids.push({ sum: new Float32Array(vectors[i].length), members: [] });
      best = centroids.length - 1;
    }
    const c = centroids[best];
    for (let k = 0; k < c.sum.length; k++) c.sum[k] += vectors[i][k] * weights[i];
    c.members.push(i);
    assigned[i] = best;
  }
  // Number speakers in the order they first speak.
  const rename = new Map<number, number>();
  return assigned.map((c) => {
    if (!rename.has(c)) rename.set(c, rename.size + 1);
    return rename.get(c)!;
  });
}
