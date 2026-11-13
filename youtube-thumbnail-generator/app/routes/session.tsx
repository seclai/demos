import { data, redirect } from "react-router";

import { ChatView } from "~/components/ChatView";
import { getAcceptedSlot } from "~/lib/attachment-refs.server";
import { ownerContext } from "~/lib/owner.server";
import { getUploadRoute } from "~/lib/routes.server";
import { getStore } from "~/lib/services.server";

import type { Route } from "./+types/session";

export async function loader({ params, context }: Route.LoaderArgs) {
  const store = getStore();
  const session = store.getSession(context.get(ownerContext), params.sessionId);
  if (!session) throw data(null, { status: 404 });
  return {
    session,
    messages: store.listMessages(session.id),
    slot: await getAcceptedSlot(),
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const ownerId = context.get(ownerContext);
  const form = await request.formData();
  const intent = form.get("intent");
  const store = getStore();

  if (intent === "rename") {
    const title = String(form.get("title") ?? "");
    if (!store.renameSession(ownerId, params.sessionId, title)) throw data(null, { status: 404 });
    return { ok: true };
  }
  if (intent === "delete") {
    const paths = store.deleteSession(ownerId, params.sessionId);
    if (!paths) throw data(null, { status: 404 });
    await getUploadRoute().removeFiles(paths);
    const current = form.get("current") === "1";
    return current ? redirect("/") : { ok: true };
  }
  throw data(null, { status: 400 });
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData?.session.title ?? "New session"} · Thumbnail Studio` }];
}

export default function SessionRoute({ loaderData }: Route.ComponentProps) {
  // Keyed so switching sessions resets the composer and any live run view.
  return <ChatView key={loaderData.session.id} {...loaderData} />;
}
