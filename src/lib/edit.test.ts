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
