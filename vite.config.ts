import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const API_PORT = Number(process.env.OCR_API_PORT ?? 5180);

export default defineConfig({
  root: 'app',
  plugins: [react()],
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
