/**
 * Vite and Vitest settings for the web app.
 * Dev server: port 5173; /api is proxied to the API so the refresh cookie stays same-origin
 * (it is SameSite=Strict). Tests run in jsdom.
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
