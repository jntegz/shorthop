import "./index.css";
import { applyAccent, savedAccent } from "./lib/accent";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useEffect, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Link, RouterProvider, useRouteError } from "react-router";
import { Toaster } from "sonner";
import { ApiError } from "./api";
import { Layout } from "./components/Layout";
import { Button, Card, Empty } from "./components/ui";
import { RequirePermission } from "./lib/me";
import { Links } from "./pages/Links";
import type { Permission } from "../shared/permissions";


applyAccent(savedAccent());

// A tab opened before a deploy still asks for the old content-hashed chunks,
// which the new deploy no longer has. Reload once to pick up the new build; the
// guard stops a loop when the chunk is really missing.
const RELOADED_KEY = "sh_chunk_reload";

function reloadOnce(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOADED_KEY) ?? 0);
    if (Date.now() - last < 10_000) return false;
    sessionStorage.setItem(RELOADED_KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

window.addEventListener("vite:preloadError", (event) => {
  if (reloadOnce()) event.preventDefault();
});

function isChunkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(msg);
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
});

function gated(Page: ComponentType, need: Permission, redirect?: string) {
  return {
    Component: () => (
      <RequirePermission need={need} redirect={redirect}>
        <Page />
      </RequirePermission>
    ),
  };
}

function NotFound() {
  return (
    <Card>
      <Empty title="Page not found">
        <Link to="/" className="text-accent hover:underline">
          Go to the dashboard
        </Link>
      </Empty>
    </Card>
  );
}

function RouteError() {
  const err = useRouteError();
  const chunk = isChunkError(err);
  useEffect(() => {
    if (chunk) reloadOnce();
  }, [chunk]);
  return (
    <Card>
      <Empty title={chunk ? "A new version of the admin is available" : "Something went wrong"}>
        <p>{chunk ? "The admin was updated since this tab was opened. Reload to continue." : "This page hit an unexpected error. Reloading usually helps."}</p>
        <div className="mt-4 flex justify-center gap-2">
          <Button onClick={() => window.location.reload()}>Reload</Button>
          {chunk ? null : (
            <Link to="/" className="inline-flex items-center px-3 text-sm text-accent hover:underline">
              Go to the dashboard
            </Link>
          )}
        </div>
      </Empty>
    </Card>
  );
}

const router = createBrowserRouter(
  [
    {
      element: <Layout />,
      errorElement: <RouteError />,
      children: [
        {
          // Errors inside a page keep the navigation around them.
          errorElement: <RouteError />,
          children: [
        // Pages with charts, QR or CSV parsing load on demand. Without the
        // permission a page needs, people see a notice (the overview: all links).
        { index: true, lazy: async () => gated((await import("./pages/Dashboard")).Dashboard, "stats.view", "/links") },
        { path: "links", element: <Links /> },
        { path: "links/:domain/:slug", lazy: async () => ({ Component: (await import("./pages/LinkDetail")).LinkDetail }) },
        { path: "hits", lazy: async () => gated((await import("./pages/RecentHits")).RecentHits, "stats.view") },
        { path: "stats", lazy: async () => gated((await import("./pages/Stats")).Stats, "stats.view") },
        { path: "sites", lazy: async () => gated((await import("./pages/Sites")).Sites, "stats.view") },
        { path: "sites/:id", lazy: async () => gated((await import("./pages/SiteDashboard")).SiteDashboard, "stats.view") },
        { path: "sites/:id/guide", lazy: async () => gated((await import("./pages/SiteGuide")).SiteGuide, "stats.view") },
        { path: "sites/:id/settings", lazy: async () => gated((await import("./pages/SiteSettings")).SiteSettings, "sites.manage") },
        { path: "health", lazy: async () => gated((await import("./pages/Health")).Health, "health.manage") },
        { path: "misses", lazy: async () => gated((await import("./pages/Misses")).Misses, "health.manage") },
        { path: "import", lazy: async () => gated((await import("./pages/Import")).Import, "links.create") },
        { path: "settings", lazy: async () => ({ Component: (await import("./pages/Settings")).Settings }) },
        { path: "*", element: <NotFound /> },
          ],
        },
      ],
    },
  ],
  { basename: "/_admin" },
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster position="bottom-right" richColors closeButton theme="light" />
    </QueryClientProvider>
  </StrictMode>,
);
