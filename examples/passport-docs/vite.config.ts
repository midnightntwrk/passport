import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

import { docsAsMarkdown } from './src/content';

/**
 * Serves and emits `/llms.txt` — the entire documentation as one plain
 * markdown document, generated from the SAME source module the site renders
 * (`src/content.ts`), so the file can never drift from the pages. In dev it
 * is served by middleware; in the build it is emitted beside `index.html`
 * (and `vercel.json` excludes it from the SPA rewrite).
 */
function llmsTxt(): Plugin {
  return {
    name: 'passport-docs-llms-txt',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] === '/llms.txt') {
          response.setHeader('content-type', 'text/plain; charset=utf-8');
          response.end(docsAsMarkdown());
          return;
        }
        next();
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'llms.txt', source: docsAsMarkdown() });
    },
  };
}

export default defineConfig({
  plugins: [react(), llmsTxt()],
  server: {
    host: 'localhost',
    /* Fixed on purpose, matching the other examples: Passport pins 5175, the
       app template 5178, the hub 5179. The docs take 5180 so all four can run
       side by side in development without a port scramble. */
    port: 5180,
    strictPort: true,
  },
  build: {
    target: 'esnext',
  },
});
