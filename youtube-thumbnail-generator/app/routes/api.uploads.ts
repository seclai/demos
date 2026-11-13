import { getUploadRoute } from "~/lib/routes.server";
import { ownerContext } from "~/lib/owner.server";

import type { Route } from "./+types/api.uploads";

export function action({ request, params, context }: Route.ActionArgs) {
  return getUploadRoute().upload(request, context.get(ownerContext), params.sessionId);
}
