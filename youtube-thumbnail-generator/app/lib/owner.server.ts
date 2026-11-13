// An anonymous owner id per browser, kept in a signed httpOnly cookie. It's
// the only identity in this demo: put real auth in front of a public deploy.

import { createContext, createCookie, type MiddlewareFunction } from "react-router";

import { getConfig } from "./config.server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let cookie: ReturnType<typeof createCookie> | null = null;

function ownerCookie() {
  cookie ??= createCookie("thumbs_owner", {
    secrets: [getConfig().sessionSecret],
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
  });
  return cookie;
}

export const ownerContext = createContext<string>();

/** Reads the owner id, or makes one and sets the cookie on the response. */
export const ownerMiddleware: MiddlewareFunction<Response> = async ({ request, context }, next) => {
  const jar = ownerCookie();
  const existing: unknown = await jar.parse(request.headers.get("cookie"));
  const ownerId = typeof existing === "string" && UUID.test(existing) ? existing : null;
  context.set(ownerContext, ownerId ?? crypto.randomUUID());

  const response = await next();
  if (ownerId) return response;

  const setCookie = await jar.serialize(context.get(ownerContext));
  try {
    response.headers.append("Set-Cookie", setCookie);
    return response;
  } catch {
    // Headers from a proxied fetch are immutable: copy the response.
    const copy = new Response(response.body, response);
    copy.headers.append("Set-Cookie", setCookie);
    return copy;
  }
};
