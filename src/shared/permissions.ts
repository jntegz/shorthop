// Roles and permissions for the people who use the admin and the API.
// The Worker enforces them (src/worker/permissions.ts); the admin uses the
// same definitions to show only what someone can do.

/** Everything someone can be allowed to do beyond viewing and copying links. */
export const PERMISSIONS = ["links.create", "links.edit", "links.delete", "stats.view", "health.manage", "settings.manage", "api.use"] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ["admin", "manager", "user"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSION_INFO: Record<Permission, { label: string; description: string }> = {
  "links.create": { label: "Create links", description: "New links, CSV import and links made from a missed visit." },
  "links.edit": { label: "Edit links", description: "Change any setting, turn links on or off, retire them and restore older versions." },
  "links.delete": { label: "Delete links", description: "Delete links and bring deleted ones back." },
  "stats.view": { label: "See statistics", description: "Overview, Full statistics and each link's statistics." },
  "health.manage": { label: "Link health & misses", description: "Check destinations and see and clear missed visits." },
  "settings.manage": { label: "Workspace settings", description: "Every setting except people and security: domains, UTM, pages, email, webhooks." },
  "api.use": { label: "Personal API keys", description: "Create API keys for scripts and tools. A key can only do what its owner can." },
};

export const ROLE_INFO: Record<Role, { label: string; description: string }> = {
  admin: { label: "Admin", description: "Everything, including people, admin rights and security." },
  manager: { label: "Manager", description: "Adds, changes and removes users, and gives them only permissions the manager has." },
  user: { label: "User", description: "Views and copies links, plus the permissions ticked below." },
};

/** Quick starting points in the Add person dialog. */
export const PERMISSION_PRESETS: { id: string; label: string; permissions: Permission[] }[] = [
  { id: "view", label: "View only", permissions: [] },
  { id: "creator", label: "Creator", permissions: ["links.create"] },
  { id: "editor", label: "Editor", permissions: ["links.create", "links.edit"] },
  { id: "links", label: "Link manager", permissions: ["links.create", "links.edit", "links.delete", "stats.view"] },
];

const KNOWN = new Set<string>(PERMISSIONS);

/** Known permissions from a list, deduplicated, in the order of PERMISSIONS. */
export function normalizePermissions(list: readonly string[]): Permission[] {
  const set = new Set(list.filter((p) => KNOWN.has(p)));
  return PERMISSIONS.filter((p) => set.has(p));
}

/** Parses the comma-separated column; unknown entries are dropped. */
export function parsePermissions(stored: string | null | undefined): Permission[] {
  return normalizePermissions((stored ?? "").split(",").map((p) => p.trim()));
}

export function formatPermissions(list: readonly Permission[]): string {
  return normalizePermissions(list).join(",");
}

/** What someone can actually do: admins can do everything. */
export function effectivePermissions(role: Role, stored: readonly Permission[]): Permission[] {
  return role === "admin" ? [...PERMISSIONS] : normalizePermissions(stored);
}

/** Who is making a request: a signed-in person, one of their API keys, or the server token. */
export interface Actor {
  email: string;
  name: string;
  role: Role;
  /** In ADMIN_EMAIL: always an admin, managed in wrangler config only. */
  owner: boolean;
  /** Effective permissions (for a key: the key's, limited to its owner's). */
  permissions: Permission[];
  via: "session" | "key" | "token";
  key?: { id: string; name: string };
}

export function can(actor: Pick<Actor, "permissions">, permission: Permission): boolean {
  return actor.permissions.includes(permission);
}

/** Admins manage everyone except owners; managers manage users only; nobody manages themselves. */
export function canManage(actor: Pick<Actor, "role" | "email">, target: { role: Role; email: string; owner?: boolean }): boolean {
  if (target.owner || target.email === actor.email) return false;
  if (actor.role === "admin") return true;
  return actor.role === "manager" && target.role === "user";
}

/** The roles someone may give. */
export function assignableRoles(actor: Pick<Actor, "role">): Role[] {
  if (actor.role === "admin") return [...ROLES];
  return actor.role === "manager" ? ["user"] : [];
}
