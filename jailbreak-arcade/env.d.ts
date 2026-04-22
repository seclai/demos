/// <reference types="astro/client" />

type KVNamespace = import('@cloudflare/workers-types').KVNamespace;

type Runtime = import('@astrojs/cloudflare').Runtime<{
  JAILBREAK_KV: KVNamespace;
  SECLAI_API_KEY: string;
  SECLAI_BANKBOT_AGENT_ID: string;
  SECLAI_JUDGE_AGENT_ID: string;
}>;

declare namespace App {
  interface Locals extends Runtime {}
}
