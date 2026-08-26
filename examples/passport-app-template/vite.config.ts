import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: 'localhost',
    /* Fixed on purpose. Passport frames your app by URL, and a dev server that
       silently moves to the next free port is a handshake that silently stops
       working. Change the number if you like — change it in Passport's
       registry entry at the same time. */
    port: 5178,
    strictPort: true,
  },
  build: {
    target: 'esnext',
  },
});
