// The signed-in person: who they are, what they may do, and the workspace
// basics every page needs. The Worker enforces every permission; the admin only
// uses them to show what someone can actually do.

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Navigate } from "react-router";
import type { Permission } from "../../shared/permissions";
import { api, call, keys } from "../api";
import { Card, Empty, Spinner } from "../components/ui";

export function useMe() {
  return useQuery({ queryKey: keys.me, queryFn: () => call(api.me.$get()), staleTime: 5 * 60_000 });
}

/** Whether the signed-in person may do something. False until /me has loaded. */
export function useCan(): (permission: Permission) => boolean {
  const me = useMe().data;
  return (permission) => me?.permissions.includes(permission) ?? false;
}

/** A page that needs a permission: elsewhere (`redirect`) or a short notice without it. */
export function RequirePermission({ need, redirect, children }: { need: Permission; redirect?: string; children: ReactNode }) {
  const me = useMe();
  if (me.isPending) {
    return (
      <div className="flex justify-center py-24">
        <Spinner />
      </div>
    );
  }
  if (me.data?.permissions.includes(need)) return children;
  if (redirect) return <Navigate to={redirect} replace />;
  return (
    <Card>
      <Empty title="You don't have access to this page">Ask an admin if you need it.</Empty>
    </Card>
  );
}
