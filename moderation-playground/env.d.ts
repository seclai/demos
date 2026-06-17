/// <reference types="astro/client" />

interface CloudflareEnv {
  SECLAI_API_KEY: string;
  SECLAI_AGENT_ID: string;
  SECLAI_BASE_URL?: string;
}

type Runtime = import('@astrojs/cloudflare').Runtime<CloudflareEnv>;

declare namespace App {
  interface Locals extends Runtime {}
}
