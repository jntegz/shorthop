import "./index.css";
// The admin's design (src/client/app, docs/DESIGN.md). Every stylesheet loads
// here, in one fixed order, never with a lazy page: otherwise which of two equal
// selectors wins would depend on the route you entered by.
import "./app/fonts.css";
import "./app/tokens.css";
import "./app/components.css";
import "./app/ui.css";
import "./app/shell.css";
import "./app/home.css";
import "./app/sites/sites.css";
import "./app/links/links.css";
import "./app/link/link.css";
import "./app/kit/kit.css";
import "./app/hits/hits.css";
import "./app/health/health.css";
import "./app/import/import.css";
import "./app/settings/settings.css";
import "./app/sitepages/sitepages.css";
import "./app/docs/docs.css";
import { applyAccent, savedAccent } from "./lib/accent";
import { applyTheme, savedTheme, useTheme } from "./lib/theme";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Link, Navigate, RouterProvider, useRouteError } from "react-router";
import { Toaster, toast } from "sonner";
import { ApiError } from "./api";
import { errorMessage } from "./components/ui";
import { Button } from "./app/ui";

applyAccent(savedAccent());
applyTheme(savedTheme());

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
  // A safety net: a change that fails without its own error handling still says so.
  mutationCache: new MutationCache({
    onError: (err, _vars, _ctx, mutation) => {
      if (mutation.options.onError) return;
      toast.error(errorMessage(err));
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
});

function ThemedToaster() {
  const theme = useTheme();
  return <Toaster position="bottom-right" richColors closeButton theme={theme === "auto" ? "system" : theme} />;
}

function RouteError() {
  const err = useRouteError();
  const chunk = isChunkError(err);
  useEffect(() => {
    if (chunk) reloadOnce();
  }, [chunk]);
  return (
    <div className="ui-page">
      <div className="ui-state">
        <p className="ui-state-title">{chunk ? "A new version of the admin is available" : "Something went wrong"}</p>
        <p className="ui-state-body">{chunk ? "The admin was updated since this tab was opened. Reload to continue." : "This page hit an unexpected error. Reloading usually helps."}</p>
        <Button onClick={() => window.location.reload()}>Reload</Button>
        {chunk ? null : <Link to="/" className="ui-link-btn">Go to the dashboard</Link>}
      </div>
    </div>
  );
}

const router = createBrowserRouter(
  [
    {
      errorElement: <RouteError />,
      lazy: async () => ({ Component: (await import("./app/Shell")).Shell }),
      children: [
        {
          // Errors inside a page keep the navigation around them.
          errorElement: <RouteError />,
          children: [
            // Pages load on demand. Without the permission a page needs, people
            // see a notice (Analytics: all links instead).
            { index: true, lazy: async () => { const [{ gate }, { Analytics }] = await Promise.all([import("./app/Gate"), import("./app/Analytics")]); return gate(Analytics, "stats.view", "/links"); } },
            { path: "stats", element: <Navigate to="/" replace /> },
            { path: "kit", lazy: async () => ({ Component: (await import("./app/kit/Kit")).Kit }) },
            { path: "links", lazy: async () => ({ Component: (await import("./app/links/Links")).LinksPage }) },
            { path: "links/:domain/:slug", lazy: async () => ({ Component: (await import("./app/link/LinkPage")).LinkPage }) },
            { path: "hits", lazy: async () => { const [{ gate }, { HitsPage }] = await Promise.all([import("./app/Gate"), import("./app/hits/Hits")]); return gate(HitsPage, "stats.view"); } },
            { path: "sites", lazy: async () => { const [{ gate }, { SitesPage }] = await Promise.all([import("./app/Gate"), import("./app/sites/Sites")]); return gate(SitesPage, "stats.view"); } },
            { path: "sites/:id", lazy: async () => { const [{ gate }, { SitePage }] = await Promise.all([import("./app/Gate"), import("./app/sites/Site")]); return gate(SitePage, "stats.view"); } },
            { path: "sites/:id/guide", lazy: async () => { const [{ gate }, { SiteGuidePage }] = await Promise.all([import("./app/Gate"), import("./app/sitepages/SiteGuide")]); return gate(SiteGuidePage, "stats.view"); } },
            { path: "sites/:id/settings", lazy: async () => { const [{ gate }, { SiteSettingsPage }] = await Promise.all([import("./app/Gate"), import("./app/sitepages/SiteSettings")]); return gate(SiteSettingsPage, "sites.manage"); } },
            { path: "health", lazy: async () => { const [{ gate }, { HealthPage }] = await Promise.all([import("./app/Gate"), import("./app/health/Health")]); return gate(HealthPage, "health.manage"); } },
            { path: "misses", lazy: async () => { const [{ gate }, { MissesPage }] = await Promise.all([import("./app/Gate"), import("./app/health/Misses")]); return gate(MissesPage, "health.manage"); } },
            { path: "import", lazy: async () => { const [{ gate }, { ImportPage }] = await Promise.all([import("./app/Gate"), import("./app/import/Import")]); return gate(ImportPage, "links.create"); } },
            { path: "settings", lazy: async () => ({ Component: (await import("./app/settings/Settings")).SettingsPage }) },
            { path: "api-docs", lazy: async () => ({ Component: (await import("./app/docs/ApiDocs")).ApiDocsPage }) },
            { path: "*", lazy: async () => ({ Component: (await import("./app/PageNotFound")).PageNotFound }) },
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
      <ThemedToaster />
    </QueryClientProvider>
  </StrictMode>,
);
