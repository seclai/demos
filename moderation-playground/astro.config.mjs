// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import cloudflare from '@astrojs/cloudflare';

// SSR via @astrojs/cloudflare so we deploy as a Cloudflare Worker and keep the
// Seclai API key off the browser. platformProxy enables miniflare in `dev` so
// `Astro.locals.runtime.env` works locally too.
export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    platformProxy: { enabled: true },
    imageService: 'compile', // no Astro <Image>, skip auto IMAGES binding
  }),
  integrations: [react()],
});
