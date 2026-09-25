import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

const API_PORT = Number(process.env.OCR_API_PORT ?? 5180);

export default defineConfig({
  root: 'app',
  // Relative asset URLs, resolved against the <base href> the server injects,
  // so one build can be mounted at / or under a path like /projects/feeling-narrative.
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(__dirname, 'app/dist'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': `http://localhost:${API_PORT}`,
    },
  },
});
