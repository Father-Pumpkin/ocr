import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      lib: { entry: 'electron/main.ts', formats: ['es'] },
      rollupOptions: {
        external: ['better-sqlite3', '@napi-rs/canvas'],
      },
    },
    resolve: {
      // Allow main.ts to import from src/ via relative paths
      alias: {
        '@core': resolve(__dirname, 'src/core'),
        '@http': resolve(__dirname, 'src/http'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      lib: { entry: 'electron/preload.ts', formats: ['es'] },
    },
  },
  renderer: {
    root: 'electron/renderer',
    plugins: [react()],
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      emptyOutDir: true,
      rollupOptions: {
        input: resolve(__dirname, 'electron/renderer/index.html'),
      },
    },
    server: {
      port: 5173,
      proxy: {
        '/api': 'http://localhost:5180',
      },
    },
  },
});
