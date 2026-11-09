/** Screen / camera / microphone capture. Recordings land in the media library and on the timeline. */
import { create } from 'zustand';
import { useStore } from '../store';
import { addMediaToTimeline } from './commands';
import { updateClip } from './edit';
import { desktop } from './desktop';
import { addCursorPath } from './smart';

export interface RecordOptions {
  screen: boolean;
  camera: boolean;
  microphone: boolean;
}

interface RecorderState {
  status: 'idle' | 'recording' | 'processing';
  startedAt: number;
  start: (options: RecordOptions) => Promise<void>;
  stop: () => void;
}

interface Session {
  recorders: { recorder: MediaRecorder; chunks: Blob[]; role: 'screen' | 'camera' | 'audio' }[];
  streams: MediaStream[];
  audioContext?: AudioContext;
  /** Desktop app: the cursor is being logged for a highlight. */
  cursor?: boolean;
}

let session: Session | null = null;

const pickMime = (video: boolean) =>
  (video
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
    : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
  ).find((m) => MediaRecorder.isTypeSupported(m));

export const canRecordScreen = () => !!navigator.mediaDevices?.getDisplayMedia && typeof MediaRecorder !== 'undefined';

function stamp() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

export const useRecorder = create<RecorderState>((set, get) => ({
  status: 'idle',
  startedAt: 0,

  start: async (options) => {
    if (get().status !== 'idle') return;
    const streams: MediaStream[] = [];
    const stopAll = () => streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    try {
      const screen = options.screen
        ? await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true })
        : null;
      if (screen) streams.push(screen);
      const user =
        options.camera || options.microphone
          ? await navigator.mediaDevices.getUserMedia({
              video: options.camera ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
              audio: options.microphone ? { echoCancellation: true, noiseSuppression: true } : false,
            })
          : null;
      if (user) streams.push(user);

      // Mix microphone and system audio into a single track for the primary recording.
      const audioInputs = [screen, user].filter((s): s is MediaStream => !!s && s.getAudioTracks().length > 0);
      let audioContext: AudioContext | undefined;
      let audioTracks: MediaStreamTrack[] = audioInputs[0]?.getAudioTracks() ?? [];
      if (audioInputs.length > 1) {
        audioContext = new AudioContext();
        const destination = audioContext.createMediaStreamDestination();
        for (const input of audioInputs) audioContext.createMediaStreamSource(new MediaStream(input.getAudioTracks())).connect(destination);
        audioTracks = destination.stream.getAudioTracks();
      }

      const recorders: Session['recorders'] = [];
      const add = (tracks: MediaStreamTrack[], role: Session['recorders'][number]['role']) => {
        const hasVideo = tracks.some((t) => t.kind === 'video');
        const recorder = new MediaRecorder(new MediaStream(tracks), { mimeType: pickMime(hasVideo), videoBitsPerSecond: 8_000_000 });
        const chunks: Blob[] = [];
        recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        recorders.push({ recorder, chunks, role });
      };
      const cameraTracks = options.camera && user ? user.getVideoTracks() : [];
      if (screen) {
        add([...screen.getVideoTracks(), ...audioTracks], 'screen');
        if (cameraTracks.length) add(cameraTracks, 'camera');
        // If the user ends sharing from the browser's own UI, finish the recording.
        screen.getVideoTracks()[0].addEventListener('ended', () => get().stop());
      } else if (cameraTracks.length) {
        add([...cameraTracks, ...audioTracks], 'camera');
      } else if (audioTracks.length) {
        add(audioTracks, 'audio');
      } else {
        throw new Error('Choose at least one thing to record');
      }

      session = { recorders, streams, audioContext };
      recorders.forEach((r) => r.recorder.start(1000));
      // In the desktop app, log where the cursor goes so it can be highlighted afterwards.
      if (screen && desktop) session.cursor = await desktop.cursorStart().catch(() => false);
      set({ status: 'recording', startedAt: Date.now() });
    } catch (err) {
      stopAll();
      const denied = err instanceof DOMException && err.name === 'NotAllowedError';
      useStore.getState().toast(denied ? 'Recording was cancelled or permission was denied' : (err as Error).message, 'error');
    }
  },

  stop: () => {
    const current = session;
    if (!current || get().status !== 'recording') return;
    session = null;
    set({ status: 'processing' });
    void (async () => {
      try {
        const files = await Promise.all(
          current.recorders.map(
            ({ recorder, chunks, role }) =>
              new Promise<{ file: File; role: string }>((resolve) => {
                recorder.onstop = () => {
                  const type = recorder.mimeType.split(';')[0] || 'video/webm';
                  const label = role === 'screen' ? 'Screen recording' : role === 'camera' ? 'Camera recording' : 'Voice recording';
                  resolve({ file: new File(chunks, `${label} ${stamp()}.${type.split('/')[1]}`, { type }), role });
                };
                recorder.stop();
              }),
          ),
        );
        current.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
        void current.audioContext?.close();
        const cursor = current.cursor && desktop ? await desktop.cursorStop().catch(() => []) : [];

        const store = useStore.getState();
        const start = store.playhead;
        let highlighted = false;
        for (const { file, role } of files) {
          const [mediaId] = await store.importFiles([file]);
          if (!mediaId) continue;
          const clipId = addMediaToTimeline(mediaId, { start });
          if (clipId && role === 'screen' && addCursorPath(clipId, cursor)) highlighted = true;
          // A camera recorded alongside the screen becomes a picture-in-picture in the corner.
          if (clipId && role === 'camera' && files.length > 1) {
            const { width, height } = useStore.getState().project;
            store.mutate((p) => updateClip(p, clipId, { scale: 0.25, x: width * 0.35, y: height * 0.35 }));
          }
        }
        if (files.length) useStore.getState().toast(highlighted ? 'Recording added to your timeline, with a highlight that follows your cursor' : 'Recording added to your timeline');
      } catch (err) {
        useStore.getState().toast(`Recording failed: ${(err as Error).message}`, 'error');
      } finally {
        set({ status: 'idle' });
      }
    })();
  },
}));
