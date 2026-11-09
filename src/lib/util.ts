export const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export function formatTime(seconds: number, fps = 30): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const frame = Math.floor((s % 1) * fps + 1e-6);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(m)}:${pad(sec)}:${pad(frame)}`;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
};

/** Track a pointer drag until release. `onMove` receives the delta from the start point. */
export function startDrag(
  e: { clientX: number; clientY: number; preventDefault?: () => void },
  onMove: (dx: number, dy: number, ev: PointerEvent) => void,
  onEnd?: (moved: boolean) => void,
) {
  const x0 = e.clientX;
  const y0 = e.clientY;
  let moved = false;
  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - x0;
    const dy = ev.clientY - y0;
    if (!moved && Math.hypot(dx, dy) < 3) return;
    moved = true;
    onMove(dx, dy, ev);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    document.body.classList.remove('dragging');
    onEnd?.(moved);
  };
  document.body.classList.add('dragging');
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}
