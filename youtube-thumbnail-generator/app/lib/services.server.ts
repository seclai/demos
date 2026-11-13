// Singletons the routes share: the store and the Seclai handlers. The API key
// stays here on the server; the browser only talks to our routes.

import { createSeclaiHandlers, type SeclaiHandlers } from "@seclai/handlers";

import { getConfig } from "./config.server";
import { getDb } from "./db.server";
import { createStore, type Store } from "./store.server";

let store: Store | null = null;
let handlers: SeclaiHandlers | null = null;

export function getStore(): Store {
  store ??= createStore(getDb());
  return store;
}

export function getSeclai(): SeclaiHandlers {
  if (!handlers) {
    const { apiKey, agentId } = getConfig();
    handlers = createSeclaiHandlers({ apiKey, agentId, runTimeoutMs: 11 * 60 * 1000 });
  }
  return handlers;
}
