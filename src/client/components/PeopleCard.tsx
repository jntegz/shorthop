import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Copy, Ellipsis, KeyRound, LogOut, Pause, Pencil, Play, ShieldCheck, Trash2, UserPlus, UserRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { PERMISSION_INFO, PERMISSION_PRESETS, PERMISSIONS, ROLE_INFO, type Permission, type Role } from "../../shared/permissions";
import type { InviteDTO, MeDTO, PersonDTO } from "../../shared/types";
import { api, call, keys } from "../api";
import { ago, fromLocalInput, toLocalInput, whenFull } from "../lib/format";
import { SETTINGS_HELP } from "../lib/help";
import { cn, copy } from "../lib/utils";
import { Badge, Button, Card, CardHeader, Dialog, Field, Input, Menu, MenuItem, MenuSeparator, Notice, Segmented, Spinner } from "./ui";

const ZERO_TRUST = "https://one.dash.cloudflare.com/";

/** What someone can do, in a few words. */
export function permissionSummary(role: Role, permissions: readonly Permission[]): string {
  if (role === "admin") return "Everything";
  return permissions.length ? permissions.map((p) => PERMISSION_INFO[p].label).join(" · ") : "View and copy links";
}

function RoleBadge({ person }: { person: Pick<PersonDTO, "role" | "owner"> }) {
  if (person.owner) return <Badge tone="accent">Owner</Badge>;
  return <Badge tone={person.role === "user" ? "neutral" : "accent"}>{ROLE_INFO[person.role].label}</Badge>;
}

function Status({ person }: { person: PersonDTO }) {
  if (person.status === "paused") {
    return (
      <Badge tone="danger" title={person.pausedBy ? `Paused by ${person.pausedBy}` : undefined}>
        {person.pausedUntil ? `Paused until ${whenFull(person.pausedUntil)}` : "Paused until resumed"}
      </Badge>
    );
  }
  if (person.status === "invited") return <Badge tone="warn">Invited · link expires {person.inviteExpiresAt ? ago(person.inviteExpiresAt) : "soon"}</Badge>;
  if (person.status === "expired") return <Badge tone="danger">Invite expired</Badge>;
  return (
    <span className="text-xs text-muted" title={person.lastLoginAt ? whenFull(person.lastLoginAt) : undefined}>
      {person.lastLoginAt ? `Signed in ${ago(person.lastLoginAt)}` : "Not signed in yet"}
    </span>
  );
}

/** Settings → People: who can sign in and what each person may do (admins and managers). */
export function PeopleCard({ me }: { me: MeDTO }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: keys.people, queryFn: () => call(api.users.$get()) });
  const [editing, setEditing] = useState<PersonDTO | "new" | null>(null);
  const [invite, setInvite] = useState<InviteDTO | null>(null);
  const [removing, setRemoving] = useState<PersonDTO | null>(null);
  const [pausing, setPausing] = useState<PersonDTO | null>(null);

  const reinvite = useMutation({
    mutationFn: (p: PersonDTO) => call(api.users[":email"].invite.$post({ param: { email: encodeURIComponent(p.email) } })),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: keys.people });
      setInvite(r);
    },
    onError: (e) => toast.error(e.message),
  });
  const resume = useMutation({
    mutationFn: (p: PersonDTO) => call(api.users[":email"].resume.$post({ param: { email: encodeURIComponent(p.email) } })),
    onSuccess: (_r, p) => {
      void qc.invalidateQueries({ queryKey: keys.people });
      toast.success(`${p.name || p.email} can sign in again`, { description: "Their API keys work again too. They sign in with their password." });
    },
    onError: (e) => toast.error(e.message),
  });
  const signOut = useMutation({
    mutationFn: (p: PersonDTO) => call(api.users[":email"]["sign-out"].$post({ param: { email: encodeURIComponent(p.email) } })),
    onSuccess: (_r, p) => toast.success(`${p.name || p.email} signed out everywhere`, { description: "Their password and API keys stay as they are." }),
    onError: (e) => toast.error(e.message),
  });
  const busy = (p: PersonDTO) =>
    [reinvite, resume, signOut].some((m) => m.isPending && m.variables?.email === p.email);

  const remove = useMutation({
    mutationFn: (p: PersonDTO) => call(api.users[":email"].$delete({ param: { email: encodeURIComponent(p.email) } })),
    onSuccess: (r, p) => {
      void qc.invalidateQueries({ queryKey: keys.people });
      setRemoving(null);
      toast.success(`${p.name || p.email} removed`, {
        description: `Their sessions${r.keysRevoked ? ` and ${r.keysRevoked} API ${r.keysRevoked === 1 ? "key" : "keys"}` : ""} stopped working. Also take them out of your Cloudflare Access policy.`,
      });
    },
    onError: (e) => toast.error(e.message),
  });

  const people = q.data?.people ?? [];
  return (
    <Card id="people" className="scroll-mt-6 lg:col-span-2">
      <CardHeader
        title="People"
        description="Who can sign in, and what each person may do. Each link's history shows who changed what."
        info={SETTINGS_HELP.people}
        action={
          <Button size="sm" onClick={() => setEditing("new")} disabled={!q.data}>
            <UserPlus /> Add person
          </Button>
        }
      />
      <div className="grid gap-6 px-5 pb-5 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        {q.isPending ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : q.isError ? (
          <Notice tone="danger">{q.error.message}</Notice>
        ) : (
          <ul className="self-start divide-y divide-line rounded-xl border border-line">
            {people.map((p) => (
              <li key={p.email} className="flex flex-wrap items-center gap-3 px-3 py-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
                  <UserRound className="size-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-fg">
                    <span className="truncate">{p.name || p.email}</span>
                    <RoleBadge person={p} />
                    {p.email === me.email ? <Badge>You</Badge> : null}
                  </p>
                  {p.name ? <p className="truncate text-xs text-muted">{p.email}</p> : null}
                  <p className="mt-1 text-xs text-muted">
                    {permissionSummary(p.role, p.permissions)}
                    {p.keys ? ` · ${p.keys} API ${p.keys === 1 ? "key" : "keys"}` : ""}
                  </p>
                  <div className="mt-1">{p.owner ? <span className="text-xs text-muted">Set in ADMIN_EMAIL</span> : <Status person={p} />}</div>
                </div>
                {p.manageable ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <Button variant="ghost" size="icon-sm" aria-label={`Edit ${p.email}`} title="Change role and permissions" onClick={() => setEditing(p)}>
                      <Pencil />
                    </Button>
                    <Menu
                      trigger={
                        <Button variant="ghost" size="icon-sm" aria-label={`More for ${p.email}`} title="Pause, sign out, reset password, remove" loading={busy(p)}>
                          {busy(p) ? null : <Ellipsis />}
                        </Button>
                      }
                    >
                      {p.status === "paused" ? (
                        <MenuItem icon={<Play />} onSelect={() => resume.mutate(p)}>
                          Resume access
                        </MenuItem>
                      ) : (
                        <MenuItem icon={<Pause />} onSelect={() => setPausing(p)}>
                          Pause access…
                        </MenuItem>
                      )}
                      {p.status === "active" ? (
                        <MenuItem icon={<LogOut />} onSelect={() => signOut.mutate(p)}>
                          Sign out everywhere
                        </MenuItem>
                      ) : null}
                      <MenuItem icon={<KeyRound />} onSelect={() => reinvite.mutate(p)}>
                        {p.status === "invited" || p.status === "expired" ? "New invite link" : "Reset password (new invite link)"}
                      </MenuItem>
                      <MenuSeparator />
                      <MenuItem icon={<Trash2 />} tone="danger" onSelect={() => setRemoving(p)}>
                        Remove…
                      </MenuItem>
                    </Menu>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <div className="space-y-3 text-sm">
          <p className="flex items-start gap-2 text-muted">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
            <span>
              Two locks: <strong className="text-fg">Cloudflare Access</strong> checks the person's email, then <strong className="text-fg">their password</strong> confirms it.
            </span>
          </p>
          <div>
            <p className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Add someone</p>
            <ol className="list-decimal space-y-1 pl-5 text-muted">
              <li>Add them here and choose what they may do.</li>
              <li>
                In{" "}
                <a href={ZERO_TRUST} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-0.5 font-medium text-accent hover:underline">
                  Cloudflare Zero Trust <ArrowUpRight className="size-3" />
                </a>{" "}
                → Access → Applications, add their email to this admin's policy.
              </li>
              <li>Send them the invite link, where they choose their own password.</li>
            </ol>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Pause or remove someone</p>
            <p className="text-muted">
              In a person's <Ellipsis className="inline size-4 align-text-bottom" aria-label="more" /> menu: <strong className="text-fg">Pause access</strong> stops their sign-in and API
              keys until a date or until you resume them, and keeps everything. <strong className="text-fg">Sign out everywhere</strong> ends their sessions but keeps their
              password. <strong className="text-fg">Remove</strong> deletes them and their API keys; then take them out of the Access policy too.
            </p>
          </div>
        </div>
      </div>

      {editing ? (
        <PersonDialog
          key={editing === "new" ? "new" : editing.email}
          me={me}
          person={editing === "new" ? null : editing}
          roles={q.data?.assignableRoles ?? []}
          onClose={() => setEditing(null)}
          onInvited={setInvite}
        />
      ) : null}
      <InviteDialog invite={invite} onClose={() => setInvite(null)} />
      {pausing ? <PauseDialog key={pausing.email} person={pausing} onClose={() => setPausing(null)} /> : null}
      <Dialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.name || removing?.email}?`}
        description="They're signed out at once and their API keys stop working. Links they created stay. Also take their email out of your Cloudflare Access policy."
      >
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setRemoving(null)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => removing && remove.mutate(removing)} loading={remove.isPending}>
            Remove
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}

/** Add someone, or change their role and permissions. */
function PersonDialog({
  me,
  person,
  roles,
  onClose,
  onInvited,
}: {
  me: MeDTO;
  person: PersonDTO | null;
  roles: Role[];
  onClose: () => void;
  onInvited: (invite: InviteDTO) => void;
}) {
  const qc = useQueryClient();
  const [email, setEmail] = useState(person?.email ?? "");
  const [name, setName] = useState(person?.name ?? "");
  const [role, setRole] = useState<Role>(person?.role ?? "user");
  // Demoting an admin starts from nothing ticked, so the choice is explicit.
  const [perms, setPerms] = useState<Permission[]>(person && person.role !== "admin" ? person.permissions : []);
  // Managers can only switch what they hold; the rest stays as it is.
  const mine = (p: Permission) => me.role === "admin" || me.permissions.includes(p);

  const save = useMutation({
    mutationFn: async () => {
      // A manager sends only what they hold; the server keeps the rest as it was.
      const permissions = role === "admin" ? [] : perms.filter(mine);
      if (person) return { kind: "edit" as const, r: await call(api.users[":email"].$patch({ param: { email: encodeURIComponent(person.email) }, json: { name, role, permissions } })) };
      return { kind: "new" as const, r: await call(api.users.$post({ json: { email, name, role, permissions } })) };
    },
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: keys.people });
      onClose();
      if (res.kind === "new") onInvited(res.r);
      else toast.success("Saved", { description: "Applies from their next click." });
    },
    onError: (e) => toast.error(e.message),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const toggle = (p: Permission, on: boolean) => setPerms((list) => (on ? [...list, p] : list.filter((x) => x !== p)));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={person ? `Change ${person.name || person.email}` : "Add a person"} wide>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email" htmlFor="person-email" hint={person ? undefined : "The address they sign in to Cloudflare Access with."}>
            <Input id="person-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={Boolean(person)} autoFocus={!person} />
          </Field>
          <Field label="Name" htmlFor="person-name" hint="Optional.">
            <Input id="person-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
        {roles.length > 1 ? (
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-fg">Role</p>
            <Segmented label="Role" value={role} onChange={setRole} options={roles.map((r) => ({ value: r, label: ROLE_INFO[r].label }))} />
            <p className="text-xs text-muted">{ROLE_INFO[role].description}</p>
          </div>
        ) : null}
        {role === "admin" ? (
          <Notice tone="accent">Admins can do everything, including adding and removing admins.</Notice>
        ) : (
          <fieldset className="space-y-2">
            <legend className="mb-1.5 text-sm font-medium text-fg">What they may do</legend>
            <p className="text-xs text-muted">Everyone can view links, copy them and download QR codes.</p>
            <div className="flex flex-wrap gap-1.5">
              {PERMISSION_PRESETS.map((preset) => (
                <Button
                  key={preset.id}
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8"
                  disabled={preset.permissions.some((p) => !mine(p))}
                  onClick={() => setPerms([...preset.permissions, ...perms.filter((p) => !mine(p))])}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
            <ul className="divide-y divide-line rounded-xl border border-line">
              {PERMISSIONS.map((p) => (
                <li key={p}>
                  <label className={cn("flex items-start gap-3 px-3 py-2.5", mine(p) ? "cursor-pointer" : "opacity-60")} title={mine(p) ? undefined : "Only an admin can change this"}>
                    <input type="checkbox" className="mt-1 accent-[var(--accent)]" checked={perms.includes(p)} disabled={!mine(p)} onChange={(e) => toggle(p, e.target.checked)} />
                    <span>
                      <span className="block text-sm font-medium text-fg">{PERMISSION_INFO[p].label}</span>
                      <span className="block text-xs text-muted">{PERMISSION_INFO[p].description}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={save.isPending}>
            {person ? "Save" : "Add and create invite"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Pause someone: until a time, or until someone resumes them (a block). */
function PauseDialog({ person, onClose }: { person: PersonDTO; onClose: () => void }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<"resume" | "date">("resume");
  const [until, setUntil] = useState(() => toLocalInput(Math.floor(Date.now() / 1000) + 7 * 86400));
  const untilSec = fromLocalInput(until);
  const error = mode === "date" && (untilSec === null || untilSec <= Date.now() / 1000) ? "Choose a time in the future." : null;
  const who = person.name || person.email;

  const save = useMutation({
    mutationFn: () => call(api.users[":email"].pause.$post({ param: { email: encodeURIComponent(person.email) }, json: { until: mode === "date" ? untilSec : null } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.people });
      onClose();
      toast.success(`${who} paused`, {
        description: mode === "date" && untilSec ? `Signed out, with API keys off, until ${whenFull(untilSec)}.` : "Signed out, with API keys off, until you resume them.",
      });
    },
    onError: (e) => toast.error(e.message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!error) save.mutate();
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Pause ${who}?`}
      description="They're signed out at once, can't sign in, and their API keys stop working. Nothing is deleted: their account, keys and links stay."
    >
      <form onSubmit={submit} className="space-y-4">
        <Segmented
          label="How long"
          value={mode}
          onChange={setMode}
          options={[
            { value: "resume", label: "Until I resume them" },
            { value: "date", label: "Until a date" },
          ]}
        />
        {mode === "date" ? (
          <Field label="Paused until" htmlFor="pause-until" hint="Their access comes back by itself at this time." error={error}>
            <Input id="pause-until" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} required />
          </Field>
        ) : (
          <p className="text-xs text-muted">Like a block: their access stays off until someone chooses Resume access in their menu.</p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" loading={save.isPending} disabled={Boolean(error)}>
            Pause access
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The one-time invite link, with what to do next. */
function InviteDialog({ invite, onClose }: { invite: InviteDTO | null; onClose: () => void }) {
  return (
    <Dialog
      open={invite !== null}
      onOpenChange={(o) => !o && onClose()}
      title={`Invite ${invite?.person.name || invite?.person.email}`}
      description="This link is shown only now. It works once, for 24 hours, and only for this email."
      wide
    >
      {invite ? (
        <div className="space-y-4 text-sm">
          <div className="flex items-center gap-2 rounded-xl border border-line bg-bg p-3">
            <code className="min-w-0 flex-1 font-mono text-xs break-all text-fg">{invite.inviteUrl}</code>
            <Button variant="outline" size="sm" onClick={() => void copy(invite.inviteUrl, "Invite link copied")}>
              <Copy /> Copy
            </Button>
          </div>
          <ol className="list-decimal space-y-1.5 pl-5 text-muted">
            <li>
              Make sure <strong className="text-fg">{invite.person.email}</strong> is in your Cloudflare Access policy (
              <a href={ZERO_TRUST} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-0.5 font-medium text-accent hover:underline">
                Zero Trust <ArrowUpRight className="size-3" />
              </a>{" "}
              → Access → Applications). Without it, the link can't open.
            </li>
            <li>Send them the link. They sign in with that email, choose a password, and they're in.</li>
          </ol>
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
