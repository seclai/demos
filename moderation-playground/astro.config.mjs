// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import node from '@astrojs/node';

// Server output keeps the Seclai key off the browser and lets API routes run
// on-demand. Node adapter makes `build` + `preview` work locally too.
export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [react()],
});
