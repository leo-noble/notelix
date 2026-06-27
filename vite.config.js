import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    assetsDir: 'assets',
    chunkSizeWarningLimit: 900
  },
  server: {
    port: 4173,
    strictPort: false
  },
  preview: {
    port: 4174,
    strictPort: false
  }
});
