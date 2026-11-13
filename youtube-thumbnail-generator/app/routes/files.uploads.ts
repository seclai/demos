import { getUploadRoute } from "~/lib/routes.server";
import { ownerContext } from "~/lib/owner.server";

import type { Route } from "./+types/files.uploads";

export function loader({ params, context }: Route.LoaderArgs) {
  return getUploadRoute().serve(context.get(ownerContext), params.uploadId);
}
