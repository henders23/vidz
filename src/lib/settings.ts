/** User settings kept in this browser only (localStorage). */
import { create } from 'zustand';

export interface Settings {
  apiKey: string;
  model: string;
  whisperModel: string;
  /** ISO code such as "en" for the language spoken in the footage. */
  language: string;
}

export const CLAUDE_MODELS: [id: string, label: string][] = [
  ['claude-opus-5-5', 'Claude Opus 5.5 (recommended)'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (faster, cheaper)'],
  ['claude-haiku-5-5', 'Claude Haiku 5.5 (fastest, cheapest)'],
  ['claude-fable-5-2', 'Claude Fable 5.2 (most capable)'],
];

export const WHISPER_MODELS: [id: string, label: string][] = [
  ['onnx-community/whisper-tiny_timestamped', 'Fast (about 40 MB download)'],
  ['onnx-community/whisper-base_timestamped', 'Balanced (about 80 MB download)'],
  ['onnx-community/whisper-small_timestamped', 'Accurate (about 250 MB download, slower)'],
];

const KEY = 'vidz:settings';
const DEFAULTS: Settings = { apiKey: '', model: CLAUDE_MODELS[0][0], whisperModel: WHISPER_MODELS[1][0], language: 'en' };

function read(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return DEFAULTS;
  }
}

export const useSettings = create<Settings & { update: (patch: Partial<Settings>) => void }>((set, get) => ({
  ...read(),
  update: (patch) => {
    set(patch);
    const { update: _omit, ...settings } = get();
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {
      // Storage unavailable (private mode): settings last for this session only.
    }
  },
}));

export const getSettings = (): Settings => useSettings.getState();
