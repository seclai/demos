import { Form, redirect } from "react-router";

import { ownerContext } from "~/lib/owner.server";
import { getStore } from "~/lib/services.server";

import type { Route } from "./+types/home";

export function loader({ context }: Route.LoaderArgs) {
  const [latest] = getStore().listSessions(context.get(ownerContext));
  if (latest) throw redirect(`/s/${latest.id}`);
  return null;
}

export default function Home() {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-5 aspect-video w-48 rounded-xl bg-gradient-to-br from-accent to-accent-hover opacity-90" />
        <h1 className="text-2xl font-semibold">Design your next thumbnail</h1>
        <p className="mt-2 text-muted">
          Upload a photo of yourself and, if you like, an image whose style you want. Then describe the video. You'll
          get 16:9 variants to refine in a chat.
        </p>
        <Form method="post" action="/s/new" className="mt-6">
          <button className="rounded-lg bg-accent px-5 py-2.5 font-medium text-on-accent hover:bg-accent-hover">
            Start a new session
          </button>
        </Form>
      </div>
    </main>
  );
}
