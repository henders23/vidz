export type MediaKind = 'video' | 'audio' | 'image';

/** Serializable description of an imported file. The bytes live in IndexedDB. */
export interface MediaAsset {
  id: string;
  name: string;
  kind: MediaKind;
  mime: string;
  size: number;
  /** Seconds. Images have 0. */
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export type TrackKind = 'video' | 'audio';

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  muted: boolean;
  hidden: boolean;
  locked: boolean;
}

/**
 * `zoom` and `effect` clips are adjustment layers: they draw nothing themselves
 * but change how everything on the tracks beneath them is rendered.
 */
export type ClipType = 'video' | 'audio' | 'image' | 'text' | 'shape' | 'zoom' | 'effect';

export interface TextProps {
  content: string;
  fontFamily: string;
  fontSize: number;
  color: string;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  /** Empty string = no background box. */
  background: string;
  outline: string;
  outlineWidth: number;
}

export type ShapeKind = 'rect' | 'ellipse' | 'arrow' | 'pulse';

export interface ShapeProps {
  kind: ShapeKind;
  width: number;
  height: number;
  /** Empty string = no fill. */
  fill: string;
  stroke: string;
  strokeWidth: number;
  radius: number;
}

export type EffectKind = 'blur' | 'pixelate' | 'spotlight';

export interface EffectProps {
  kind: EffectKind;
  region: 'rect' | 'ellipse';
  width: number;
  height: number;
  /** Blur radius (px), pixel block size (px), or spotlight dimming (0..1). */
  amount: number;
}

export type TransitionType = 'dissolve' | 'wipe' | 'push' | 'zoom' | 'dip';

/** How a clip enters. If another clip ends exactly where this one starts, it is blended with that clip. */
export interface Transition {
  type: TransitionType;
  duration: number;
}

export interface Filters {
  brightness: number; // 1 = unchanged
  contrast: number;
  saturation: number;
  blur: number; // px
}

export interface Clip {
  id: string;
  trackId: string;
  type: ClipType;
  mediaId?: string;
  /** Timeline position, seconds. */
  start: number;
  /** Length on the timeline, seconds. */
  duration: number;
  /** Where in the source the clip begins, seconds. */
  offset: number;
  speed: number;
  /**
   * Offset of the clip's centre from the canvas centre, in canvas pixels.
   * For zoom clips, x/y is the centre of the zoomed area and `scale` is the
   * fraction of the canvas it covers (0.5 = 2x zoom); fades are the ease in/out.
   */
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  filters: Filters;
  text?: TextProps;
  shape?: ShapeProps;
  effect?: EffectProps;
  transition?: Transition;
  /** Text clip generated from the transcript; regenerating captions replaces these. */
  caption?: boolean;
}

export interface Project {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  background: string;
  /** Top-most visual layer first. */
  tracks: Track[];
  clips: Clip[];
  media: MediaAsset[];
}

export const isVisual = (c: Clip) => c.type !== 'audio';
export const hasSound = (c: Clip) => c.type === 'video' || c.type === 'audio';
export const clipEnd = (c: Clip) => c.start + c.duration;
export const isOverlay = (type: ClipType) => type === 'text' || type === 'shape' || type === 'zoom' || type === 'effect';
export const canTransition = (c: Clip) => c.type === 'video' || c.type === 'image' || c.type === 'text' || c.type === 'shape';

/** A transcribed word, timed in seconds within its source media. */
export interface Word {
  text: string;
  start: number;
  end: number;
}

/** A word placed on the timeline through the clip that plays it. */
export interface TimelineWord extends Word {
  clipId: string;
}

export interface TimeRange {
  start: number;
  end: number;
}
