import { getConfig } from "./config.server";
import { createSeclaiRoute } from "./seclai-route.server";
import { getSeclai, getStore } from "./services.server";
import { createUploadRoute } from "./uploads.server";

let seclaiRoute: ReturnType<typeof createSeclaiRoute> | null = null;
let uploadRoute: ReturnType<typeof createUploadRoute> | null = null;

export function getSeclaiRoute() {
  seclaiRoute ??= createSeclaiRoute({ store: getStore(), seclai: getSeclai() });
  return seclaiRoute;
}

export function getUploadRoute() {
  uploadRoute ??= createUploadRoute({ store: getStore(), seclai: getSeclai(), dataDir: getConfig().dataDir });
  return uploadRoute;
}
