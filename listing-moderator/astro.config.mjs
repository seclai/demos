// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import cloudflare from '@astrojs/cloudflare';

// SSR via @astrojs/cloudflare so we deploy as a Cloudflare Worker and keep the
// Seclai API key off the browser. In v13 the adapter uses @cloudflare/vite-plugin
// which wires `Astro.locals.runtime.env` from wrangler.toml in `dev` automatically.
export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    imageService: 'compile', // no Astro <Image>, skip auto IMAGES binding
  }),
  integrations: [react()],
});
