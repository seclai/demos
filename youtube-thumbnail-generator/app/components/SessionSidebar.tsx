import { useState } from "react";
import { Form, NavLink, useFetcher, useParams } from "react-router";

import type { SessionSummary } from "~/lib/types";

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(ms).toLocaleDateString();
}

function SessionRow({ session, active }: { session: SessionSummary; active: boolean }) {
  const fetcher = useFetcher();
  const [editing, setEditing] = useState(false);
  const pendingTitle = fetcher.formData?.get("intent") === "rename" ? String(fetcher.formData.get("title")) : null;
  const deleting = fetcher.formData?.get("intent") === "delete";
  const title = pendingTitle ?? session.title ?? "New session";

  if (deleting) return null;

  if (editing) {
    return (
      <li className="px-2 py-1">
        <fetcher.Form
          method="post"
          action={`/s/${session.id}`}
          onSubmit={() => setEditing(false)}
          className="flex gap-1"
        >
          <input type="hidden" name="intent" value="rename" />
          <input
            name="title"
            defaultValue={session.title ?? ""}
            autoFocus
            maxLength={120}
            aria-label="Session name"
            onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
            className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-sm"
          />
          <button className="rounded-md bg-accent px-2 text-xs font-medium text-on-accent">Save</button>
        </fetcher.Form>
      </li>
    );
  }

  return (
    <li className="group relative">
      <NavLink
        to={`/s/${session.id}`}
        className={`block rounded-lg px-3 py-2 pr-16 ${active ? "bg-surface-2" : "hover:bg-surface-2/60"}`}
      >
        <span className="block truncate text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted">{relativeTime(session.updatedAt)}</span>
      </NavLink>
      <div className="absolute inset-y-0 right-2 flex items-center gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="rounded p-1 text-xs text-muted hover:bg-border hover:text-text"
          aria-label={`Rename ${title}`}
          title="Rename"
        >
          ✎
        </button>
        <fetcher.Form
          method="post"
          action={`/s/${session.id}`}
          onSubmit={(e) => {
            if (!confirm(`Delete "${title}"? Its images and uploads will be removed from this app.`)) e.preventDefault();
          }}
        >
          <input type="hidden" name="intent" value="delete" />
          <input type="hidden" name="current" value={active ? "1" : "0"} />
          <button
            className="rounded p-1 text-xs text-muted hover:bg-border hover:text-danger"
            aria-label={`Delete ${title}`}
            title="Delete"
          >
            ✕
          </button>
        </fetcher.Form>
      </div>
    </li>
  );
}

export function SessionSidebar({
  sessions,
  open,
  onClose,
}: {
  sessions: SessionSummary[];
  open: boolean;
  onClose(): void;
}) {
  const { sessionId } = useParams();
  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={onClose} aria-hidden />}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-border bg-surface transition-transform md:static md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
        aria-label="Sessions"
      >
        <div className="flex items-center justify-between px-4 pb-3 pt-4">
          <a href="/" className="font-semibold tracking-tight">
            <span className="text-accent">▶</span> Thumbnail Studio
          </a>
          <button type="button" onClick={onClose} className="text-muted md:hidden" aria-label="Close sessions">
            ✕
          </button>
        </div>
        <Form method="post" action="/s/new" className="px-3">
          <button className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover">
            + New session
          </button>
        </Form>
        <nav className="mt-3 flex-1 overflow-y-auto px-2 pb-4">
          {sessions.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted">No sessions yet.</p>
          ) : (
            <ul className="space-y-0.5">
              {sessions.map((s) => (
                <SessionRow key={s.id} session={s} active={s.id === sessionId} />
              ))}
            </ul>
          )}
        </nav>
        <p className="border-t border-border px-4 py-3 text-xs text-muted">
          Sessions are tied to this browser.
        </p>
      </aside>
    </>
  );
}
