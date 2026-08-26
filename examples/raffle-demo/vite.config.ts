import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: 'localhost',
    // Fixed: the Passport app registry points at http://localhost:5177.
    port: 5177,
    strictPort: true,
  },
  build: {
    target: 'esnext',
  },
});
