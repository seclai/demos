import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import { ownerMiddleware } from "~/lib/owner.server";

import type { Route } from "./+types/root";
import "./app.css";

export const middleware: Route.MiddlewareFunction[] = [ownerMiddleware];

export const meta: Route.MetaFunction = () => [
  { title: "Thumbnail Studio" },
  { name: "description", content: "Design YouTube thumbnails from your photo by chatting with a Seclai agent." },
];

export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "/favicon.ico" },
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..700&display=swap",
  },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    title = error.status === 404 ? "Not found" : `Error ${error.status}`;
    details = error.status === 404 ? "That session doesn't exist, or it isn't yours." : error.statusText || details;
  } else if (error instanceof Error) {
    details = error.message;
    if (import.meta.env.DEV) stack = error.stack;
  }

  return (
    <main className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2 text-muted">{details}</p>
      <a href="/" className="mt-4 inline-block text-accent underline">Back to your sessions</a>
      {stack && (
        <pre className="mt-6 overflow-x-auto rounded-lg bg-surface-2 p-4 text-xs">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
