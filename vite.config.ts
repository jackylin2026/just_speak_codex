import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The window loads this in development and the built bundle in a packaged app; the API is
// a separate process either way (the shell spawns it), so there is no server middleware
// here and nothing to proxy.
export default defineConfig({
  plugins: [react()],
  // Keep the terminal clear of anything but Rust errors.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    // Two windows, two pages: the rec bar and the detail box are separate documents, so neither
    // has to know how to be the other.
    rollupOptions: { input: { recBar: 'rec-bar.html', detail: 'detail.html' } },
  },
});
