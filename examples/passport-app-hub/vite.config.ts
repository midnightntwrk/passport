import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: 'localhost',
    /* Fixed on purpose, matching the other examples: Passport runs on 5175,
       the app template on 5178. The hub takes 5179 so the three can run
       side by side in development without a port scramble. */
    port: 5179,
    strictPort: true,
  },
  build: {
    target: 'esnext',
  },
});
