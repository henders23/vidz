/** The small, explicit bridge between the vidz web app and the desktop shell. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vidzDesktop', {
  /** Called with the available screens and windows when a recording is about to start. */
  onPickSource: (handler) => {
    const listener = (_event, sources) => handler(sources);
    ipcRenderer.on('capture:pick', listener);
    return () => ipcRenderer.removeListener('capture:pick', listener);
  },
  /** Answer the picker: a source id, or null to cancel. */
  chooseSource: (id) => ipcRenderer.invoke('capture:choose', id),
  /** Start logging the cursor position on the recorded screen. Resolves false if a window (not a screen) is being recorded. */
  cursorStart: () => ipcRenderer.invoke('cursor:start'),
  /** Stop logging; resolves to [{ time, x, y }] with x/y as fractions of the screen. */
  cursorStop: () => ipcRenderer.invoke('cursor:stop'),
});
