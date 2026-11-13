// Resource route for @seclai/react's `useAgentRun`: /api/seclai/:action.

import { getSeclaiRoute } from "~/lib/routes.server";
import { ownerContext } from "~/lib/owner.server";

import type { Route } from "./+types/api.seclai";

export function loader({ request, params, context }: Route.LoaderArgs) {
  return getSeclaiRoute()(request, context.get(ownerContext), params.action);
}

export function action({ request, params, context }: Route.ActionArgs) {
  return getSeclaiRoute()(request, context.get(ownerContext), params.action);
}
