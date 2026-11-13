import { useState } from "react";
import { Outlet, useLocation } from "react-router";

import { SessionSidebar } from "~/components/SessionSidebar";
import { ownerContext } from "~/lib/owner.server";
import { getStore } from "~/lib/services.server";

import type { Route } from "./+types/layout";

export function loader({ context }: Route.LoaderArgs) {
  return { sessions: getStore().listSessions(context.get(ownerContext)) };
}

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  const [lastPath, setLastPath] = useState(location.pathname);
  if (location.pathname !== lastPath) {
    // Close the phone drawer after navigating.
    setLastPath(location.pathname);
    setDrawerOpen(false);
  }

  return (
    <div className="flex h-dvh overflow-hidden">
      <SessionSidebar sessions={loaderData.sessions} open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-border bg-surface px-4 py-3 md:hidden">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="rounded-md border border-border px-2.5 py-1.5 text-sm"
            aria-label="Open sessions"
          >
            ☰
          </button>
          <span className="font-semibold">Thumbnail Studio</span>
        </header>
        <Outlet />
      </div>
    </div>
  );
}
