// The signed-in person: who they are, what they may do, and the workspace
// basics every page needs. The Worker enforces every permission; the admin only
// uses them to show what someone can actually do.

import { useQuery } from "@tanstack/react-query";
import type { Permission } from "../../shared/permissions";
import { api, call, keys } from "../api";

export function useMe() {
  return useQuery({ queryKey: keys.me, queryFn: () => call(api.me.$get()), staleTime: 5 * 60_000 });
}

/** Whether the signed-in person may do something. False until /me has loaded. */
export function useCan(): (permission: Permission) => boolean {
  const me = useMe().data;
  return (permission) => me?.permissions.includes(permission) ?? false;
}
