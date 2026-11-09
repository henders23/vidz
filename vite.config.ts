import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative asset paths, so one build works on the web and inside the desktop app.
  base: './',
  plugins: [react()],
  server: { host: true },
});
