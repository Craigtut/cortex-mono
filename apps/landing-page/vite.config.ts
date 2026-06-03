import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';

export default defineConfig({
  server: { port: 3000 },
  resolve: {
    alias: {
      // Resolve the brand tokens from source for HMR and to avoid build-order
      // coupling on the workspace package's dist output.
      '@animus-labs/brand': fileURLToPath(
        new URL('../../packages/brand/src/index.ts', import.meta.url),
      ),
    },
  },
  plugins: [
    tanstackStart({
      prerender: { enabled: true, crawlLinks: true },
    }),
    viteReact(),
  ],
});
