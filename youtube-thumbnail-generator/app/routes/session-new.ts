import { redirect } from "react-router";

import { ownerContext } from "~/lib/owner.server";
import { getStore } from "~/lib/services.server";

import type { Route } from "./+types/session-new";

export function action({ context }: Route.ActionArgs) {
  const session = getStore().createSession(context.get(ownerContext));
  return redirect(`/s/${session.id}`);
}

export function loader() {
  return redirect("/");
}
