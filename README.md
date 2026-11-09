# vidz

A local-first video editor that runs in the browser: record your screen, cut on a multi-track
timeline, add titles and callouts, and export an MP4 — no install, no account, nothing uploaded.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # unit tests for the editing engine
npm run build    # type-check + production build in dist/
```

Use a recent Chrome or Edge for the best experience (export uses WebCodecs).

## What works today

- **Media library** – import video, audio and images by drag-and-drop or file picker; filmstrips and waveforms are generated on import.
- **Recording** – screen, camera and microphone. A camera recorded with the screen lands as a picture-in-picture.
- **Timeline** – unlimited video/audio tracks, drag to move, trim handles, split, ripple delete, duplicate, snapping (hold Alt to disable), zoom, track mute/hide/lock, full undo/redo.
- **Preview** – real-time composited playback; click, drag and resize clips directly on the canvas with centre guides.
- **Properties** – position, scale, rotation, opacity, volume, speed, fades, colour filters; text styling; rectangle / ellipse / arrow callouts.
- **Tutorial tools**
  - *Zoom & pan* – drop a zoom clip on the timeline and drag a box over the area to zoom into; it eases in and out.
  - *Blur / pixelate* – cover sensitive information with a resizable region.
  - *Spotlight* – dim everything except the area you want people to look at.
  - *Click pulse* – an animated ring to mark a click or a spot.
  - *Transitions* – cross dissolve, wipe, push, zoom and fade-through between clips.
- **Keyframed motion** – any clip can change position, size, rotation and opacity over time: press `K` to add a keyframe, move the playhead, then move or resize the clip. Blurs and spotlights can follow a moving target, zooms can pan, titles can slide in. Keyframes show as diamonds on the timeline and can be dragged to retime.
- **Motion tracking** – place a blur, spotlight, shape or text over something, choose Track motion, and it follows that thing to the end of the clip by writing keyframes for you. It can also follow the target getting bigger or smaller.
- **Cursor highlight** – add a soft highlight, drop it on the mouse cursor once, and it follows the cursor through the recording (it watches for the small thing that moves on an otherwise still screen).
- **AI assistant** – describe an edit in plain English and Claude carries it out on your timeline using the editor's own commands. It can read the transcript and look at frames, and each request is a single undo step. Needs your own Anthropic API key (Settings), which stays in your browser.
- **Transcript tools** – speech is transcribed on your device with Whisper (nothing is uploaded). Generate captions, click a word to jump to it, or select words and cut them out of the video. Captions can be saved as SRT or WebVTT files, and the transcript as plain text. Speakers can be told apart and named (also on your device), so the transcript shows who said what.
- **Remove silences** – cuts silent pauses out of the whole timeline in one click. No AI or key needed.
- **Export** – frame-accurate MP4 (or WebM) at a chosen resolution, frame rate and quality, with mixed audio.
- **Projects** – keep as many projects as you like; each is autosaved with its media in the browser (IndexedDB) and restored on reload. Open, create and delete them from the Projects window (`Ctrl/Cmd+O`).
- **Command palette** (`Ctrl/Cmd+K`) and keyboard shortcuts (`?`).

## Architecture

| Path | Role |
| --- | --- |
| `src/types.ts` | The project document: a plain JSON tree of tracks, clips and media. |
| `src/lib/edit.ts` | Pure editing operations (`Project -> Project`). No DOM, fully unit-tested. |
| `src/lib/commands.ts` | Named commands with descriptions and JSON-schema parameters. Shortcuts, the palette and `window.vidz` all go through here. |
| `src/lib/render.ts` | Frame compositor shared by preview and export, so what you see is what you get. |
| `src/lib/playback.ts` | Preview engine: the playhead is the master clock, media elements follow it. |
| `src/lib/export.ts` | Offline render: frames are decoded and encoded with WebCodecs via [mediabunny](https://mediabunny.dev) (falling back to seeking a `<video>` element for files it cannot decode), audio mixed with `OfflineAudioContext`. |
| `src/lib/media.ts` | Import, probing, thumbnails, waveform peaks, IndexedDB storage. |
| `src/lib/recorder.ts` | Screen / camera / microphone capture. |
| `src/lib/ai.ts` | The assistant: a streaming Claude tool-use loop whose tools are generated from the command registry. |
| `src/lib/smart.ts` | Captions, silence removal, project summary and frame snapshots (used by the UI and as assistant tools). |
| `src/lib/track.ts` | Motion tracking by template matching on small greyscale frames. |
| `src/lib/transcribe.ts`, `whisper.worker.ts` | In-browser Whisper speech-to-text and speaker voiceprints in a web worker. |
| `src/lib/speakers.ts` | Groups voiceprints into speakers. |
| `src/store.ts` | Zustand store: project, selection, playhead, undo history, autosave. |
| `src/components/` | React UI. |

### Adjustment layers

Zoom and effect (blur / pixelate / spotlight) clips draw nothing themselves: they change how every
track *beneath* them is rendered. That keeps them ordinary timeline clips (move, trim, split, fade,
undo) and means a callout placed on a track above a zoom stays fixed on screen while the footage
below zooms.

### How the assistant works

Every edit is a serialisable command against a JSON project. `src/lib/ai.ts` turns each
parameterised command into a Claude tool, sends the user's request with a compact project summary,
and runs the tool calls Claude returns until it is done. Adding a command to the registry makes it
available to the assistant, the command palette and scripts at once:

```js
vidz.listCommands();                                   // id, description and parameter schema for each command
vidz.getProject();                                     // the full project document
vidz.run('timeline.addText', { content: 'Intro', start: 0, duration: 3 });
vidz.run('timeline.removeSilences', { minDuration: 0.8 });
```

Privacy: the assistant sends Claude the project summary, your message, the transcript when it asks
for it, and still frames when it needs to see the picture. Video and audio files never leave the
browser. Requests go directly from the browser to `api.anthropic.com` with the key from Settings;
there is no vidz server. Because the key lives in the browser, this setup is for personal use, not
for hosting vidz publicly with a shared key.

## Roadmap

1. Faster transcription on WebGPU.
2. An optional desktop build.
