import "./index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Link, RouterProvider } from "react-router";
import { Toaster } from "sonner";
import { ApiError } from "./api";
import { Layout } from "./components/Layout";
import { Card, Empty } from "./components/ui";
import { Links } from "./pages/Links";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
});

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
        // Pages with charts, QR or CSV parsing load on demand.
        { index: true, lazy: async () => ({ Component: (await import("./pages/Dashboard")).Dashboard }) },
        { path: "links", element: <Links /> },
        { path: "links/:domain/:slug", lazy: async () => ({ Component: (await import("./pages/LinkDetail")).LinkDetail }) },
        { path: "stats", lazy: async () => ({ Component: (await import("./pages/Stats")).Stats }) },
        { path: "misses", lazy: async () => ({ Component: (await import("./pages/Misses")).Misses }) },
        { path: "import", lazy: async () => ({ Component: (await import("./pages/Import")).Import }) },
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
