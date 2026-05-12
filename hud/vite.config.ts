import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite is fronted by Tauri's webview. We pin the port (1421) to match
// `tauri.conf.json`'s `devUrl` and disable HMR overlay so it doesn't get in
// the way of an always-on-top transparent window.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 1421,
    strictPort: true,
    hmr: {
      port: 1422,
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    minify: 'esbuild',
    sourcemap: false,
  },
});
