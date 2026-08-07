import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The API origin follows the same environment variables the server reads
// (main.ts: API_HOST/API_PORT), so a non-default port cannot silently break
// the dev proxy.
const apiTarget = `http://${process.env.API_HOST ?? '127.0.0.1'}:${process.env.API_PORT ?? '3000'}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? '5173'),
    proxy: {
      '/api': apiTarget,
      '/documentation': apiTarget,
    },
  },
});
