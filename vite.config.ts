import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { resolve } from 'path';

export default defineConfig({
  root: resolve(__dirname, 'ui'),
  plugins: [viteSingleFile()],
  build: {
    outDir: resolve(__dirname, 'ui/dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'ui/mcp-app.html'),
    },
  },
});
