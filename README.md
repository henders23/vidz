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
- **Export** – frame-accurate MP4 (or WebM) at a chosen resolution, frame rate and quality, with mixed audio.
- **Autosave** – the project and its media are stored in the browser (IndexedDB) and restored on reload.
- **Command palette** (`Ctrl/Cmd+K`) and keyboard shortcuts (`?`).

## Architecture

| Path | Role |
| --- | --- |
| `src/types.ts` | The project document: a plain JSON tree of tracks, clips and media. |
| `src/lib/edit.ts` | Pure editing operations (`Project -> Project`). No DOM, fully unit-tested. |
| `src/lib/commands.ts` | Named commands with descriptions and JSON-schema parameters. Shortcuts, the palette and `window.vidz` all go through here. |
| `src/lib/render.ts` | Frame compositor shared by preview and export, so what you see is what you get. |
| `src/lib/playback.ts` | Preview engine: the playhead is the master clock, media elements follow it. |
| `src/lib/export.ts` | Offline render via WebCodecs + [mediabunny](https://mediabunny.dev), audio mixed with `OfflineAudioContext`. |
| `src/lib/media.ts` | Import, probing, thumbnails, waveform peaks, IndexedDB storage. |
| `src/lib/recorder.ts` | Screen / camera / microphone capture. |
| `src/store.ts` | Zustand store: project, selection, playhead, undo history, autosave. |
| `src/components/` | React UI. |

### Built for AI editing

Every edit is a serialisable command against a JSON project, which is exactly the shape an AI agent
needs. The same API is already exposed for scripting:

```js
vidz.listCommands();                                   // id, description and parameter schema for each command
vidz.getProject();                                     // the full project document
vidz.run('timeline.addText', { content: 'Intro', start: 0, duration: 3 });
vidz.run('clip.update', { clipId, patch: { scale: 0.5, fadeIn: 1 } });
```

`listCommands()` maps directly onto LLM tool definitions, so an assistant panel can be added without
touching the editor core.

## Roadmap

1. AI assistant: chat-driven editing on top of the command layer, transcription, captions, silence and filler-word removal.
2. Tutorial tools: zoom-and-pan keyframes, cursor highlighting, blur/redact regions, transitions between clips.
3. Faster export (WebCodecs decoding instead of per-frame seeking), multiple projects, optional desktop build.
