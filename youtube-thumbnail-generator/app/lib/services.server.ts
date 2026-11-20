// Singletons the routes share: the store and the configured Seclai handlers.
// The API key stays here on the server; the browser only talks to our routes.

import { getConfig } from "./config.server";
import { getDb } from "./db.server";
import { createLogger } from "./log.server";
import { type AppSeclai, createAppSeclai } from "./seclai.server";
import { createStore, type Store } from "./store.server";

let store: Store | null = null;
let seclai: AppSeclai | null = null;

export function getStore(): Store {
  store ??= createStore(getDb());
  return store;
}

export function getSeclai(): AppSeclai {
  if (!seclai) {
    const { apiKey, agentId, dataDir } = getConfig();
    seclai = createAppSeclai({ store: getStore(), apiKey, agentId, dataDir, logger: createLogger("seclai") });
  }
  return seclai;
}
