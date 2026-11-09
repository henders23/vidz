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
