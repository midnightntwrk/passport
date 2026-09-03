import { defineConfig } from 'vitest/config';

/* The tally rules are plain functions over a plain object, so they need no
   environment beyond Node and no fixtures beyond the state they are handed. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
