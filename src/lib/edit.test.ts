import { describe, expect, it } from 'vitest';
import * as edit from './edit';
import { MediaAsset, Project } from '../types';

const video: MediaAsset = { id: 'v', name: 'v.mp4', kind: 'video', mime: 'video/mp4', size: 1, duration: 10, width: 1920, height: 1080, hasAudio: true };
const song: MediaAsset = { id: 'a', name: 'a.mp3', kind: 'audio', mime: 'audio/mpeg', size: 1, duration: 30, width: 0, height: 0, hasAudio: true };

function setup(): Project {
  return edit.addMedia(edit.addMedia(edit.createProject(), video), song);
}
const add = (p: Project, mediaId: string, start: number, trackId?: string) => {
  const r = edit.addMediaClip(p, mediaId, { start, trackId });
  return { p: r.project, id: r.clipId! };
};

describe('placement', () => {
  it('puts video on the video track and audio on the audio track', () => {
    let { p, id } = add(setup(), 'v', 0);
    const a = add(p, 'a', 0);
    p = a.p;
    const kinds = Object.fromEntries(p.tracks.map((t) => [t.id, t.kind]));
    expect(kinds[edit.getClip(p, id)!.trackId]).toBe('video');
    expect(kinds[edit.getClip(p, a.id)!.trackId]).toBe('audio');
    expect(edit.projectDuration(p)).toBe(30);
  });

  it('creates a new track on top when the spot is taken', () => {
    const first = add(setup(), 'v', 0);
    const second = add(first.p, 'v', 5);
    expect(second.p.tracks.filter((t) => t.kind === 'video')).toHaveLength(2);
    expect(second.p.tracks[0].id).toBe(edit.getClip(second.p, second.id)!.trackId);
  });

  it('never overlaps clips when a track is given explicitly', () => {
    const first = add(setup(), 'v', 0);
    const trackId = edit.getClip(first.p, first.id)!.trackId;
    const second = add(first.p, 'v', 4, trackId);
    expect(edit.getClip(second.p, second.id)!.start).toBe(10);
  });

  it('places text above existing footage', () => {
    const first = add(setup(), 'v', 0);
    const { project, clipId } = edit.addTextClip(first.p, { start: 2 });
    const order = project.tracks.map((t) => t.id);
    expect(order.indexOf(edit.getClip(project, clipId)!.trackId)).toBeLessThan(order.indexOf(edit.getClip(project, first.id)!.trackId));
  });
});

describe('split / trim', () => {
  it('splits a clip keeping source continuity', () => {
    const { p, id } = add(setup(), 'v', 2);
    const out = edit.splitAt(edit.updateClip(p, id, { speed: 2, duration: 5 }), 4);
    const [a, b] = out.clips.sort((x, y) => x.start - y.start);
    expect([a.start, a.duration, a.offset]).toEqual([2, 2, 0]);
    expect([b.start, b.duration, b.offset]).toEqual([4, 3, 4]);
  });

  it('cannot trim past the source media', () => {
    const { p, id } = add(setup(), 'v', 0);
    expect(edit.getClip(edit.trimClip(p, id, 'end', 99), id)!.duration).toBe(10);
    const trimmed = edit.trimClip(p, id, 'start', 3);
    expect(edit.getClip(trimmed, id)).toMatchObject({ start: 3, duration: 7, offset: 3 });
    expect(edit.getClip(edit.trimClip(trimmed, id, 'start', -5), id)).toMatchObject({ start: 0, offset: 0, duration: 10 });
  });

  it('cannot trim into a neighbour', () => {
    const first = add(setup(), 'v', 0);
    const trackId = edit.getClip(first.p, first.id)!.trackId;
    const second = add(first.p, 'v', 10, trackId);
    const shortened = edit.trimClip(second.p, first.id, 'end', 6);
    expect(edit.getClip(edit.trimClip(shortened, second.id, 'start', 2), second.id)!.start).toBe(10);
    expect(edit.getClip(edit.trimClip(shortened, first.id, 'end', 50), first.id)!.duration).toBe(10);
  });
});

describe('delete / move / speed', () => {
  it('ripple delete closes the gap on that track only', () => {
    const first = add(setup(), 'v', 0);
    const trackId = edit.getClip(first.p, first.id)!.trackId;
    const second = add(first.p, 'v', 10, trackId);
    const music = add(second.p, 'a', 12);
    const out = edit.deleteClips(music.p, [first.id], true);
    expect(edit.getClip(out, second.id)!.start).toBe(0);
    expect(edit.getClip(out, music.id)!.start).toBe(12);
  });

  it('refuses to move a clip onto the wrong kind of track', () => {
    const { p, id } = add(setup(), 'v', 0);
    const audioTrack = p.tracks.find((t) => t.kind === 'audio')!.id;
    const moved = edit.moveClip(p, id, 3, audioTrack);
    expect(edit.getClip(moved, id)).toMatchObject({ start: 3, trackId: edit.getClip(p, id)!.trackId });
  });

  it('speed changes the timeline length', () => {
    const { p, id } = add(setup(), 'v', 0);
    expect(edit.getClip(edit.setClipSpeed(p, id, 2), id)!.duration).toBe(5);
  });

  it('computes fades', () => {
    const { p, id } = add(setup(), 'v', 0);
    const clip = { ...edit.getClip(p, id)!, fadeIn: 2, fadeOut: 2 };
    expect(edit.fadeFactor(clip, 1)).toBeCloseTo(0.5);
    expect(edit.fadeFactor(clip, 5)).toBe(1);
    expect(edit.fadeFactor(clip, 9.5)).toBeCloseTo(0.25);
  });
});

describe('tutorial tools', () => {
  it('zoom clips land above footage and transform the layers below', () => {
    const { p, id } = add(setup(), 'v', 0);
    const z = edit.addZoomClip(p, { start: 1 });
    const zoom = edit.getClip(z.project, z.clipId)!;
    const order = z.project.tracks.map((t) => t.id);
    expect(order.indexOf(zoom.trackId)).toBeLessThan(order.indexOf(edit.getClip(p, id)!.trackId));

    const project = edit.updateClip(z.project, zoom.id, { x: 480, y: 270, scale: 0.5 });
    const below = edit.getClip(project, id)!.trackId;
    // Fully zoomed in: the chosen area (centre 1440,810; half-size 480x270) fills the 1920x1080 frame.
    const view = edit.zoomTransform(project, 3, below);
    expect(view.k).toBeCloseTo(2);
    expect(view.k * 960 + view.tx).toBeCloseTo(0);
    expect(view.k * 1920 + view.tx).toBeCloseTo(1920);
    expect(view.k * 1080 + view.ty).toBeCloseTo(1080);
    // Outside the zoom, at its very start, and for the zoom's own track: untouched.
    expect(edit.zoomTransform(project, 0.5, below)).toEqual({ k: 1, tx: 0, ty: 0 });
    expect(edit.zoomTransform(project, 1, below).k).toBeCloseTo(1);
    expect(edit.zoomTransform(project, 3, zoom.trackId).k).toBe(1);
    expect(edit.zoomTransform(project, 3, below, zoom.id).k).toBe(1);
  });

  it('keeps the zoom area inside the canvas', () => {
    const z = edit.addZoomClip(setup(), { start: 0 });
    const clip = { ...edit.getClip(z.project, z.clipId)!, x: 5000, y: -5000, scale: 0.5 };
    expect(edit.zoomCentre(clip, z.project)).toEqual({ x: 480, y: -270 });
  });

  it('holds the previous clip on screen during a transition', () => {
    const first = add(setup(), 'v', 0);
    const trackId = edit.getClip(first.p, first.id)!.trackId;
    const second = add(first.p, 'v', 10, trackId);
    const p = edit.setTransition(second.p, second.id, 'dissolve', 1);
    const during = edit.renderItems(p, 10.5);
    expect(during.map((i) => [i.clip.id, i.held, i.transition?.role])).toEqual([[first.id, true, 'out'], [second.id, false, 'in']]);
    expect(during[1].transition!.progress).toBeCloseTo(0.5);
    expect(during[0].localTime).toBeCloseTo(10 - 1 / 30);
    expect(edit.renderItems(p, 11.5).map((i) => i.clip.id)).toEqual([second.id]);
    expect(edit.renderItems(p, 9).map((i) => i.clip.id)).toEqual([first.id]);
    // Removing it, or splitting, never leaves a transition on the second half.
    expect(edit.getClip(edit.setTransition(p, second.id, null), second.id)!.transition).toBeUndefined();
    const halves = edit.splitClip(p, second.id, 15).clips.filter((c) => c.start >= 10).sort((a, b) => a.start - b.start);
    expect(halves.map((c) => !!c.transition)).toEqual([true, false]);
  });

  it('does not allow transitions on adjustment layers', () => {
    const fx = edit.addEffectClip(setup(), 'blur', { start: 0 });
    expect(edit.setTransition(fx.project, fx.clipId, 'wipe')).toBe(fx.project);
  });
});

describe('AI-assisted editing primitives', () => {
  it('ripple cut removes ranges from every track and keeps them in sync', () => {
    const v = add(setup(), 'v', 0); // video 0-10
    const a = add(v.p, 'a', 0); // music 0-30
    const t = edit.addTextClip(a.p, { start: 6 }); // text 6-11
    const out = edit.rippleCut(t.project, [{ start: 4, end: 5 }, { start: 2, end: 3 }]);
    const vids = out.clips.filter((c) => c.type === 'video').sort((x, y) => x.start - y.start);
    // 0-2 | 3-4 | 5-10 of the source, butted together.
    expect(vids.map((c) => [c.start, c.duration, c.offset])).toEqual([[0, 2, 0], [2, 1, 3], [3, 5, 5]]);
    expect(new Set(vids.map((c) => c.id)).size).toBe(3);
    expect(out.clips.filter((c) => c.type === 'audio').reduce((n, c) => n + c.duration, 0)).toBe(28);
    expect(edit.getClip(out, t.clipId)).toMatchObject({ start: 4, duration: 5 });
    expect(edit.projectDuration(out)).toBe(28);
  });

  it('ripple cut drops clips that fall wholly inside a range and leaves locked tracks alone', () => {
    const v = add(setup(), 'v', 0);
    const t = edit.addTextClip(v.p, { start: 2 }); // 2-7
    const locked = edit.updateTrack(t.project, edit.getClip(v.p, v.id)!.trackId, { locked: true });
    const out = edit.rippleCut(locked, [{ start: 1, end: 8 }]);
    expect(edit.getClip(out, t.clipId)).toBeUndefined();
    expect(edit.getClip(out, v.id)).toMatchObject({ start: 0, duration: 10 });
  });

  it('finds silent pauses from waveform peaks', () => {
    const { p } = add(setup(), 'v', 0);
    const rate = 50;
    const peaks = new Float32Array(10 * rate).fill(0.5);
    peaks.fill(0.001, 2 * rate, 4 * rate); // 2s pause
    peaks.fill(0.001, 6 * rate, 6.3 * rate); // too short to count
    const found = edit.findSilences(p, () => peaks, rate, { minDuration: 0.6, padding: 0.1 });
    expect(found).toHaveLength(1);
    expect(found[0].start).toBeCloseTo(2.1);
    expect(found[0].end).toBeCloseTo(3.9);
    // Unknown waveform => assume sound; muted clip => not considered at all.
    expect(edit.findSilences(p, () => undefined, rate)).toEqual([]);
    expect(edit.findSilences(edit.updateClip(p, p.clips[0].id, { volume: 0 }), () => peaks, rate)).toEqual([]);
  });

  it('maps transcript words through trims and speed onto the timeline', () => {
    const { p, id } = add(setup(), 'v', 5);
    const words = [{ text: 'cut', start: 0.5, end: 0.9 }, { text: 'hello', start: 2, end: 2.5 }, { text: 'world', start: 4, end: 5 }];
    const trimmed = edit.setClipSpeed(edit.trimClip(p, id, 'start', 6), id, 2); // source from 1s, 2x
    const mapped = edit.timelineWords(trimmed, () => words);
    expect(mapped.map((w) => [w.text, w.start, w.end])).toEqual([['hello', 6.5, 6.75], ['world', 7.5, 8]]);
  });

  it('builds caption lines and replaces captions on a dedicated track', () => {
    const { p } = add(setup(), 'v', 0);
    const w = (text: string, start: number) => ({ text, start, end: start + 0.3, clipId: 'x' });
    const lines = edit.captionLines([w('Hello', 0), w('there.', 0.4), w('This', 1), w('is', 1.4), w('vidz', 1.8), w('later', 5)], 20);
    expect(lines.map((l) => l.text)).toEqual(['Hello there.', 'This is vidz', 'later']);
    expect(lines[0].end).toBeLessThanOrEqual(lines[1].start);
    const once = edit.setCaptions(p, lines);
    const twice = edit.setCaptions(once, lines.slice(0, 2));
    expect(once.clips.filter((c) => c.caption)).toHaveLength(3);
    expect(twice.clips.filter((c) => c.caption)).toHaveLength(2);
    expect(twice.tracks.filter((t) => t.name === edit.CAPTION_TRACK)).toHaveLength(1);
    expect(twice.tracks[0].name).toBe(edit.CAPTION_TRACK);
    const styled = edit.styleCaptions(twice, { y: 100, text: { color: '#ffff00' } });
    expect(styled.clips.filter((c) => c.caption).every((c) => c.y === 100 && c.text!.color === '#ffff00' && c.text!.content.length > 0)).toBe(true);
    expect(edit.setCaptions(twice, []).clips.some((c) => c.caption)).toBe(false);
  });
});

describe('keyframed motion', () => {
  const animated = () => {
    const base = edit.addEffectClip(setup(), 'blur', { start: 10 }); // 10-15
    let p = edit.setKeyframe(base.project, base.clipId, 10, { x: 0, y: 0 });
    p = edit.setKeyframe(p, base.clipId, 12, { x: 200, y: 100, width: 300 });
    p = edit.setKeyframe(p, base.clipId, 14, { x: 400, y: 0 });
    return { p, id: base.clipId };
  };
  const at = (p: Project, id: string, t: number) => edit.resolveClip(edit.getClip(p, id)!, t);

  it('passes through every keyframe and holds outside them', () => {
    const { p, id } = animated();
    expect(at(p, id, 10)).toMatchObject({ x: 0, y: 0 });
    expect(at(p, id, 12)).toMatchObject({ x: 200, y: 100 });
    expect(at(p, id, 12).effect!.width).toBe(300);
    expect(at(p, id, 14.9)).toMatchObject({ x: 400, y: 0 });
    // Smooth motion keeps moving through the middle keyframe; linear is exactly proportional.
    const mid = at(p, id, 11).x;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(200);
    const linear = edit.updateClip(p, id, { motion: 'linear' });
    expect(at(linear, id, 11)).toMatchObject({ x: 100, y: 50 });
    expect(at(linear, id, 13).x).toBeCloseTo(300);
    // A still clip is returned untouched.
    const still = edit.addTextClip(setup(), { start: 0 });
    expect(edit.resolveClip(still.project.clips[0], 1)).toBe(still.project.clips[0]);
  });

  it('auto-keys edits on an animated clip and plainly updates a still one', () => {
    const { p, id } = animated();
    const edited = edit.applyTransform(p, id, 13, { y: -50 });
    expect(edit.getClip(edited, id)!.keyframes).toHaveLength(4);
    expect(at(edited, id, 13).y).toBe(-50);
    // Editing on an existing keyframe updates it instead of adding another.
    expect(edit.getClip(edit.applyTransform(p, id, 12.005, { y: 7 }), id)!.keyframes).toHaveLength(3);
    const still = edit.addEffectClip(setup(), 'blur', { start: 0 });
    const moved = edit.applyTransform(still.project, still.clipId, 1, { x: 30, width: 99 });
    expect(edit.getClip(moved, still.clipId)!.x).toBe(30);
    expect(edit.getClip(moved, still.clipId)!.keyframes).toBeUndefined();
    expect(edit.getClip(moved, still.clipId)!.effect!.width).toBe(99);
  });

  it('keeps animation at the same timeline moments through trim, split and ripple cut', () => {
    const { p, id } = animated();
    const linear = edit.updateClip(p, id, { motion: 'linear' });
    const trimmed = edit.trimClip(linear, id, 'start', 11);
    expect(at(trimmed, id, 12)).toMatchObject({ x: 200, y: 100 });
    expect(at(trimmed, id, 11).x).toBeCloseTo(100);
    const split = edit.splitClip(linear, id, 13);
    const second = split.clips.find((c) => c.type === 'effect' && c.start === 13)!;
    expect(edit.resolveClip(second, 13).x).toBeCloseTo(300);
    expect(edit.resolveClip(second, 14).x).toBeCloseTo(400);
    expect(at(split, id, 12).x).toBe(200);
    const cut = edit.rippleCut(linear, [{ start: 11, end: 12 }]);
    const right = cut.clips.find((c) => c.type === 'effect' && Math.abs(c.start - 11) < 1e-6)!;
    expect(edit.resolveClip(right, 11).x).toBeCloseTo(200);
    expect(edit.resolveClip(right, 13).x).toBeCloseTo(400);
  });

  it('removes, retimes and clears keyframes', () => {
    const { p, id } = animated();
    const moved = edit.moveKeyframe(p, id, 1, 99); // cannot pass the next keyframe
    expect(edit.getClip(moved, id)!.keyframes![1].time).toBeCloseTo(4 - 1 / 30);
    expect(edit.getClip(edit.removeKeyframe(p, id, 1), id)!.keyframes).toHaveLength(2);
    const cleared = edit.clearKeyframes(p, id, 12);
    expect(edit.getClip(cleared, id)).toMatchObject({ x: 200, y: 100, keyframes: undefined });
    expect(edit.getClip(cleared, id)!.effect!.width).toBe(300);
    const replaced = edit.setKeyframes(p, id, [{ time: 14, x: 5 }, { time: 10, x: 1 }], 'linear');
    expect(edit.getClip(replaced, id)!.keyframes!.map((k) => [k.time, k.x])).toEqual([[0, 1], [4, 5]]);
    expect(edit.getClip(edit.setKeyframes(p, id, []), id)!.keyframes).toBeUndefined();
  });

  it('pans a zoom between keyframed areas', () => {
    const v = add(setup(), 'v', 0);
    const z = edit.addZoomClip(v.p, { start: 0 }); // 0-4, eases 0.6s
    let p = edit.updateClip(z.project, z.clipId, { motion: 'linear' });
    p = edit.setKeyframe(p, z.clipId, 1, { x: -480, y: 0, scale: 0.5 });
    p = edit.setKeyframe(p, z.clipId, 3, { x: 480, y: 0, scale: 0.5 });
    const below = edit.getClip(p, v.id)!.trackId;
    const centreX = (t: number) => { const view = edit.zoomTransform(p, t, below); return (960 - view.tx) / view.k - 960; };
    expect(centreX(1)).toBeCloseTo(-480);
    expect(centreX(2)).toBeCloseTo(0);
    expect(centreX(3)).toBeCloseTo(480);
  });
});
