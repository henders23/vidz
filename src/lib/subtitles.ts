/** Caption file formats. */
import { CaptionLine } from './edit';

function stamp(seconds: number, separator: string): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${separator}${pad(ms % 1000, 3)}`;
}

// A blank line ends a cue in both formats, so captions must not contain one.
const clean = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');

const usable = (lines: CaptionLine[]) => lines.filter((l) => clean(l.text) && l.end > l.start).sort((a, b) => a.start - b.start);

/** SubRip (.srt): the most widely accepted format (YouTube, Vimeo, LinkedIn, most players). */
export function toSrt(lines: CaptionLine[]): string {
  return usable(lines)
    .map((l, i) => `${i + 1}\n${stamp(l.start, ',')} --> ${stamp(l.end, ',')}\n${clean(l.text)}\n`)
    .join('\n');
}

/** WebVTT (.vtt): the format for HTML5 video `<track>` elements. */
export function toVtt(lines: CaptionLine[]): string {
  const cues = usable(lines).map((l) => `${stamp(l.start, '.')} --> ${stamp(l.end, '.')}\n${clean(l.text).replace(/-->/g, '->')}\n`);
  return `WEBVTT\n\n${cues.join('\n')}`;
}

/** Plain text transcript, one paragraph per longer pause. */
export function toText(lines: CaptionLine[]): string {
  const sorted = usable(lines);
  let out = '';
  sorted.forEach((l, i) => {
    if (i > 0) out += l.start - sorted[i - 1].end > 1.2 ? '\n\n' : ' ';
    out += clean(l.text).replace(/\n/g, ' ');
  });
  return out + (out ? '\n' : '');
}
