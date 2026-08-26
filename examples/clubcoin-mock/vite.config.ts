import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: 'localhost',
    /* Fixed on purpose, and the number matters. The Passport origin and this
       app's origin must DIFFER — a callback contract tested against itself
       proves nothing about the audience binding — and the callback URL is
       typed into a launch parameter, so a dev server that silently moves to
       the next free port is a round trip that silently stops working.
       5175 Passport · 5176 profile client · 5177 raffle · 5178 template ·
       5179 hub · 5181 ClubCoin. */
    port: 5181,
    strictPort: true,
  },
  build: {
    target: 'esnext',
  },
});
