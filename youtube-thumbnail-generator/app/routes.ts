import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  layout("routes/layout.tsx", [
    index("routes/home.tsx"),
    route("s/:sessionId", "routes/session.tsx"),
  ]),
  route("s/new", "routes/session-new.ts"),
  route("api/seclai/:action", "routes/api.seclai.ts"),
  route("api/sessions/:sessionId/uploads", "routes/api.uploads.ts"),
  route("files/uploads/:uploadId", "routes/files.uploads.ts"),
] satisfies RouteConfig;
