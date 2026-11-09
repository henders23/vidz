/** Features that exist only inside the vidz desktop app (see `desktop/`). */

export interface CaptureSource {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  /** PNG data URL. */
  thumbnail: string;
}

export interface CursorSample {
  time: number;
  /** Fractions of the recorded screen's width and height. */
  x: number;
  y: number;
}

interface DesktopBridge {
  onPickSource: (handler: (sources: CaptureSource[]) => void) => () => void;
  chooseSource: (id: string | null) => Promise<void>;
  cursorStart: () => Promise<boolean>;
  cursorStop: () => Promise<CursorSample[]>;
}

export const desktop: DesktopBridge | undefined = (window as unknown as { vidzDesktop?: DesktopBridge }).vidzDesktop;
