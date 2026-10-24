import "./index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Link, RouterProvider } from "react-router";
import { Toaster } from "sonner";
import { ApiError } from "./api";
import { Layout } from "./components/Layout";
import { Card, Empty } from "./components/ui";
import { RequirePermission } from "./lib/me";
import { Links } from "./pages/Links";
import type { Permission } from "../shared/permissions";

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

const router = createBrowserRouter(
  [
    {
      element: <Layout />,
      children: [
        // Pages with charts, QR or CSV parsing load on demand. Without the
        // permission a page needs, people see a notice (the overview: all links).
        { index: true, lazy: async () => gated((await import("./pages/Dashboard")).Dashboard, "stats.view", "/links") },
        { path: "links", element: <Links /> },
        { path: "links/:domain/:slug", lazy: async () => ({ Component: (await import("./pages/LinkDetail")).LinkDetail }) },
        { path: "hits", lazy: async () => gated((await import("./pages/RecentHits")).RecentHits, "stats.view") },
        { path: "stats", lazy: async () => gated((await import("./pages/Stats")).Stats, "stats.view") },
        { path: "health", lazy: async () => gated((await import("./pages/Health")).Health, "health.manage") },
        { path: "misses", lazy: async () => gated((await import("./pages/Misses")).Misses, "health.manage") },
        { path: "import", lazy: async () => gated((await import("./pages/Import")).Import, "links.create") },
        { path: "settings", lazy: async () => ({ Component: (await import("./pages/Settings")).Settings }) },
        { path: "*", element: <NotFound /> },
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
