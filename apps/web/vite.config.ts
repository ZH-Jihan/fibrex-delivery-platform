/**
 * Vite and Vitest settings for the web app.
 * Dev server: port 5173 (strictPort: it fails rather than moving, so Playwright and the proxy
 * always find it); /api is proxied to the API so the refresh cookie stays same-origin
 * (it is SameSite=Strict). Tests run in jsdom.
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  // E2E_WEB_PORT / E2E_API_PORT let Playwright run its own web and API pair (isolated database).
  server: {
    port: Number(process.env.E2E_WEB_PORT ?? 5173),
    strictPort: true,
    proxy: { '/api': `http://localhost:${process.env.E2E_API_PORT ?? '3000'}` },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
