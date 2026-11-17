// The Seclai handlers for `useAgentRun` and the composer: /api/seclai/:action.

import { ownerContext } from "~/lib/owner.server";
import { getSeclai } from "~/lib/services.server";

import type { Route } from "./+types/api.seclai";

export function loader({ request, params, context }: Route.LoaderArgs) {
  return getSeclai().handle(request, context.get(ownerContext), params.action);
}

export function action({ request, params, context }: Route.ActionArgs) {
  return getSeclai().handle(request, context.get(ownerContext), params.action);
}
