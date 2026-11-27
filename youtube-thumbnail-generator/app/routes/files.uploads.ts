import { ownerContext } from "~/lib/owner.server";
import { getSeclai } from "~/lib/services.server";

import type { Route } from "./+types/files.uploads";

export function loader({ params, context }: Route.LoaderArgs) {
  return getSeclai().serveUpload(context.get(ownerContext), params.uploadId);
}
