// Permission gate for pages: the page's skeleton while /me loads, a retry if it
// fails, then the page, a redirect, or a short notice without the permission.

import type { ComponentType } from "react";
import { Navigate } from "react-router";
import type { Permission } from "../../shared/permissions";
import { useMe } from "../lib/me";
import { ErrorState, Skeleton } from "./parts";

function PageSkeleton() {
  return (
    <div className="ui-page" aria-busy aria-label="Loading">
      <header className="ui-head">
        <div className="ui-head-main">
          <Skeleton className="ui-skel-text" style={{ width: 140, height: 22 }} />
          <Skeleton className="ui-skel-text" style={{ width: 260 }} />
        </div>
      </header>
      <Skeleton className="ui-skel-chart" style={{ height: 96, marginBottom: 16 }} />
      <Skeleton className="ui-skel-chart" style={{ height: 236 }} />
    </div>
  );
}

export function gate(Page: ComponentType, need: Permission, redirect?: string) {
  return {
    Component: function Gated() {
      const me = useMe();
      if (me.isPending) return <PageSkeleton />;
      if (me.isError && !me.data) return <div className="ui-page"><ErrorState what="Your account" error={me.error} onRetry={() => void me.refetch()} /></div>;
      if (me.data?.permissions.includes(need)) return <Page />;
      if (redirect) return <Navigate to={redirect} replace />;
      return (
        <div className="ui-page">
          <div className="ui-state">
            <p className="ui-state-title">You don’t have access to this page.</p>
            <p className="ui-state-body">Ask an admin if you need it.</p>
          </div>
        </div>
      );
    },
  };
}
