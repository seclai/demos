/// <reference types="astro/client" />

type KVNamespace = import('@cloudflare/workers-types').KVNamespace;

interface CloudflareEnv {
  JAILBREAK_KV: KVNamespace;
  SECLAI_API_KEY: string;
  SECLAI_BANKBOT_AGENT_ID: string;
  SECLAI_JUDGE_AGENT_ID: string;
  SECLAI_STUB?: string;
}

type Runtime = import('@astrojs/cloudflare').Runtime<CloudflareEnv>;

declare namespace App {
  interface Locals extends Runtime {}
}
