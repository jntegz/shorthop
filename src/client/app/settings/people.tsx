// Settings → People: who can sign in and what each person may do (admins and
// managers).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ellipsis, KeyRound, LogOut, Pause, Pencil, Play, ShieldCheck, Trash2, UserPlus, UserRound } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { PERMISSION_INFO, PERMISSION_PRESETS, PERMISSIONS, ROLE_INFO, type Permission, type Role } from "../../../shared/permissions";
import type { InviteDTO, MeDTO, PersonDTO } from "../../../shared/types";
import { api, call, keys } from "../../api";
import { ago, fromLocalInput, toLocalInput, whenFull } from "../../lib/format";
import { SETTINGS_HELP } from "../../lib/help";
import { Badge, Button, Checkbox, Dialog, ErrorState, IconButton, Input, Menu, Notice, Section, Segmented, type MenuItem } from "../ui";
import { ExternalLink, HelpTip, RowsLoading, SecretField, toastError } from "./parts";

const ZERO_TRUST = "https://one.dash.cloudflare.com/";

/** What someone can do, in a few words. */
export function permissionSummary(role: Role, permissions: readonly Permission[]): string {
  if (role === "admin") return "Everything";
  return permissions.length ? permissions.map((p) => PERMISSION_INFO[p].label).join(" · ") : "View and copy links";
}

/** "Owner", "Admin", "Manager", "User". */
export function roleLabel(person: Pick<PersonDTO, "role" | "owner">): string {
  return person.owner ? "Owner" : ROLE_INFO[person.role].label;
}

function Status({ person }: { person: PersonDTO }) {
  if (person.owner) return <span className="settings-a-quiet">Set in ADMIN_EMAIL</span>;
  if (person.status === "paused") {
    return (
      <span title={person.pausedBy ? `Paused by ${person.pausedBy}` : undefined}>
        <Badge tone="warn">{person.pausedUntil ? `Paused until ${whenFull(person.pausedUntil)}` : "Paused until resumed"}</Badge>
      </span>
    );
  }
  if (person.status === "invited") return <Badge tone="neutral">Invited · link expires {person.inviteExpiresAt ? ago(person.inviteExpiresAt) : "soon"}</Badge>;
  if (person.status === "expired") return <Badge tone="warn">Invite expired</Badge>;
  return (
    <span className="settings-a-quiet" title={person.lastLoginAt ? whenFull(person.lastLoginAt) : undefined}>
      {person.lastLoginAt ? `Signed in ${ago(person.lastLoginAt)}` : "Not signed in yet"}
    </span>
  );
}

export function PeopleSection({ me }: { me: MeDTO }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: keys.people, queryFn: () => call(api.users.$get()) });
  const [editing, setEditing] = useState<PersonDTO | "new" | null>(null);
  const [invite, setInvite] = useState<InviteDTO | null>(null);
  const [removing, setRemoving] = useState<PersonDTO | null>(null);
  const [pausing, setPausing] = useState<PersonDTO | null>(null);

  // With email that reaches people, a new link is also emailed to them.
  const canEmail = Boolean(q.data) && !q.data?.emailProblem;
  const reinvite = useMutation({
    mutationFn: (p: PersonDTO) => call(api.users[":email"].invite.$post({ param: { email: encodeURIComponent(p.email) }, json: { sendEmail: canEmail } })),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: keys.people });
      setInvite(r);
    },
    onError: toastError,
  });
  const resume = useMutation({
    mutationFn: (p: PersonDTO) => call(api.users[":email"].resume.$post({ param: { email: encodeURIComponent(p.email) } })),
    onSuccess: (_r, p) => {
      void qc.invalidateQueries({ queryKey: keys.people });
      toast.success(`${p.name || p.email} can sign in again`, { description: "Their API keys work again too. They sign in with their password." });
    },
    onError: toastError,
  });
  const signOut = useMutation({
    mutationFn: (p: PersonDTO) => call(api.users[":email"]["sign-out"].$post({ param: { email: encodeURIComponent(p.email) } })),
    onSuccess: (_r, p) => toast.success(`${p.name || p.email} signed out everywhere`, { description: "Their password and API keys stay as they are." }),
    onError: toastError,
  });
  const busy = (p: PersonDTO) => [reinvite, resume, signOut].some((m) => m.isPending && m.variables?.email === p.email);

  const remove = useMutation({
    mutationFn: (p: PersonDTO) => call(api.users[":email"].$delete({ param: { email: encodeURIComponent(p.email) } })),
    onSuccess: (r, p) => {
      void qc.invalidateQueries({ queryKey: keys.people });
      setRemoving(null);
      toast.success(`${p.name || p.email} removed`, {
        description: `Their sessions${r.keysRevoked ? ` and ${r.keysRevoked} API ${r.keysRevoked === 1 ? "key" : "keys"}` : ""} stopped working. Also take them out of your Cloudflare Access policy.`,
      });
    },
    onError: toastError,
  });

  const menuFor = (p: PersonDTO): (MenuItem | "separator")[] => [
    p.status === "paused" ? { label: "Resume access", icon: Play, onSelect: () => resume.mutate(p) } : { label: "Pause access…", icon: Pause, onSelect: () => setPausing(p) },
    ...(p.status === "active" ? [{ label: "Sign out everywhere", icon: LogOut, onSelect: () => signOut.mutate(p) }] : []),
    {
      label: `${p.status === "invited" || p.status === "expired" ? "New invite link" : "Reset password (new invite link)"}${canEmail ? " by email" : ""}`,
      icon: KeyRound,
      onSelect: () => reinvite.mutate(p),
    },
    "separator",
    { label: "Remove…", icon: Trash2, danger: true, onSelect: () => setRemoving(p) },
  ];

  const people = q.data?.people ?? [];
  return (
    <Section
      id="people"
      title="People"
      sub="Who can sign in, and what each person may do. Each link's history shows who changed what."
      aside={
        <>
          <Button size="sm" icon={UserPlus} onClick={() => setEditing("new")} disabled={!q.data}>
            Add person
          </Button>
          <HelpTip help={SETTINGS_HELP.people} />
        </>
      }
    >
      <div className="settings-a-two is-wide-first">
        <div>
          {q.isPending ? (
            <RowsLoading rows={3} />
          ) : q.isError ? (
            <ErrorState what="People" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} compact />
          ) : (
            <ul className="settings-a-list" aria-label="People">
              {people.map((p) => (
                <li key={p.email} className="settings-a-item">
                  <span className="settings-a-avatar" aria-hidden>
                    <UserRound />
                  </span>
                  <div className="settings-a-item-main">
                    <p className="settings-a-item-title">
                      <span className="settings-a-name">{p.name || p.email}</span>
                      <span className="settings-a-role">{roleLabel(p)}</span>
                      {p.email === me.email ? <Badge>You</Badge> : null}
                    </p>
                    {p.name ? <p className="settings-a-item-sub settings-a-ellipsis">{p.email}</p> : null}
                    <p className="settings-a-item-sub">
                      {permissionSummary(p.role, p.permissions)}
                      {p.keys ? ` · ${p.keys} API ${p.keys === 1 ? "key" : "keys"}` : ""}
                    </p>
                    <p className="settings-a-item-sub">
                      <Status person={p} />
                    </p>
                  </div>
                  {p.manageable ? (
                    <div className="settings-a-item-tools">
                      <IconButton size="sm" icon={Pencil} label={`Edit ${p.email}`} title="Change role and permissions" onClick={() => setEditing(p)} />
                      <Menu label={`Actions for ${p.email}`} trigger={<IconButton size="sm" icon={Ellipsis} label={`More for ${p.email}`} loading={busy(p)} />} items={menuFor(p)} />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="settings-a-guide">
          <p className="settings-a-lead">
            <ShieldCheck aria-hidden />
            <span>
              Two locks: <strong>Cloudflare Access</strong> checks the person's email, then <strong>their password</strong> confirms it.
            </span>
          </p>
          <h3 className="settings-a-h3">Add someone</h3>
          <ol className="settings-a-steps">
            <li>Add them here and choose what they may do.</li>
            <li>
              In <ExternalLink href={ZERO_TRUST}>Cloudflare Zero Trust</ExternalLink> → Access → Applications, add their email to this admin's policy.
            </li>
            <li>Send them the invite link, where they choose their own password.</li>
          </ol>
          <h3 className="settings-a-h3">Pause or remove someone</h3>
          <p className="settings-a-prose">
            In a person's <Ellipsis className="settings-a-inline-icon" aria-label="more" /> menu: <strong>Pause access</strong> stops their sign-in and API keys until a date or until you resume them, and keeps everything.{" "}
            <strong>Sign out everywhere</strong> ends their sessions but keeps their password. <strong>Remove</strong> deletes them and their API keys; then take them out of the Access policy too.
          </p>
        </div>
      </div>

      {editing ? (
        <PersonDialog
          key={editing === "new" ? "new" : editing.email}
          me={me}
          person={editing === "new" ? null : editing}
          roles={q.data?.assignableRoles ?? []}
          canEmail={canEmail}
          onClose={() => setEditing(null)}
          onInvited={setInvite}
        />
      ) : null}
      <InviteDialog invite={invite} onClose={() => setInvite(null)} />
      {pausing ? <PauseDialog key={pausing.email} person={pausing} onClose={() => setPausing(null)} /> : null}
      <Dialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.name || removing?.email || ""}?`}
        description="They're signed out at once and their API keys stop working. Links they created stay. Also take their email out of your Cloudflare Access policy."
        size="sm"
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => removing && remove.mutate(removing)} loading={remove.isPending}>
              Remove
            </Button>
          </>
        }
      />
    </Section>
  );
}

/** Add someone, or change their role and permissions. */
function PersonDialog({
  me,
  person,
  roles,
  canEmail,
  onClose,
  onInvited,
}: {
  me: MeDTO;
  person: PersonDTO | null;
  roles: Role[];
  canEmail: boolean;
  onClose: () => void;
  onInvited: (invite: InviteDTO) => void;
}) {
  const qc = useQueryClient();
  const formId = useId();
  const [email, setEmail] = useState(person?.email ?? "");
  const [name, setName] = useState(person?.name ?? "");
  const [role, setRole] = useState<Role>(person?.role ?? "user");
  // Demoting an admin starts from nothing ticked, so the choice is explicit.
  const [perms, setPerms] = useState<Permission[]>(person && person.role !== "admin" ? person.permissions : []);
  const [sendEmail, setSendEmail] = useState(canEmail);
  // Managers can only switch what they hold; the rest stays as it is.
  const mine = (p: Permission) => me.role === "admin" || me.permissions.includes(p);

  const save = useMutation({
    mutationFn: async () => {
      // A manager sends only what they hold; the server keeps the rest as it was.
      const permissions = role === "admin" ? [] : perms.filter(mine);
      if (person) return { kind: "edit" as const, r: await call(api.users[":email"].$patch({ param: { email: encodeURIComponent(person.email) }, json: { name, role, permissions } })) };
      return { kind: "new" as const, r: await call(api.users.$post({ json: { email, name, role, permissions, sendEmail: canEmail && sendEmail } })) };
    },
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: keys.people });
      onClose();
      if (res.kind === "new") onInvited(res.r);
      else toast.success("Saved", { description: "Applies from their next click." });
    },
    onError: toastError,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const toggle = (p: Permission, on: boolean) => setPerms((list) => (on ? [...list, p] : list.filter((x) => x !== p)));

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={person ? `Change ${person.name || person.email}` : "Add a person"}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form={formId} variant="primary" loading={save.isPending}>
            {person ? "Save" : "Add and create invite"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="settings-a-form">
        <div className="settings-a-pair">
          <Input
            label="Email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={Boolean(person)}
            hint={person ? undefined : "The address they sign in to Cloudflare Access with."}
          />
          <Input label="Name" hint="Optional." value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </div>
        {roles.length > 1 ? (
          <fieldset className="settings-a-fieldset">
            <legend className="ui-field-label">Role</legend>
            <Segmented label="Role" value={role} onChange={setRole} options={roles.map((r) => ({ value: r, label: ROLE_INFO[r].label }))} />
            <p className="settings-a-hint">{ROLE_INFO[role].description}</p>
          </fieldset>
        ) : null}
        {role === "admin" ? (
          <Notice tone="info">Admins can do everything, including adding and removing admins.</Notice>
        ) : (
          <fieldset className="settings-a-fieldset">
            <legend className="ui-field-label">What they may do</legend>
            <p className="settings-a-hint">Everyone can view links, copy them and download QR codes.</p>
            <div className="settings-a-presets" role="group" aria-label="Presets">
              {PERMISSION_PRESETS.map((preset) => (
                <Button
                  key={preset.id}
                  size="sm"
                  disabled={preset.permissions.some((p) => !mine(p))}
                  onClick={() => setPerms([...preset.permissions, ...perms.filter((p) => !mine(p))])}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
            <div className="settings-a-checks">
              {PERMISSIONS.map((p) => (
                <div key={p} title={mine(p) ? undefined : "Only an admin can change this"}>
                  <Checkbox
                    label={PERMISSION_INFO[p].label}
                    description={mine(p) ? PERMISSION_INFO[p].description : `${PERMISSION_INFO[p].description} Only an admin can change this.`}
                    checked={perms.includes(p)}
                    disabled={!mine(p)}
                    onCheckedChange={(on) => toggle(p, on)}
                  />
                </div>
              ))}
            </div>
          </fieldset>
        )}
        {!person && canEmail ? <Checkbox label="Also email the invite link to them" checked={sendEmail} onCheckedChange={setSendEmail} /> : null}
      </form>
    </Dialog>
  );
}

/** Pause someone: until a time, or until someone resumes them (a block). */
function PauseDialog({ person, onClose }: { person: PersonDTO; onClose: () => void }) {
  const qc = useQueryClient();
  const formId = useId();
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
    onError: toastError,
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
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form={formId} variant="danger" loading={save.isPending} disabled={Boolean(error)}>
            Pause access
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="settings-a-form">
        <fieldset className="settings-a-fieldset">
          <legend className="ui-field-label">How long</legend>
          <Segmented
            label="How long"
            value={mode}
            onChange={setMode}
            options={[
              { value: "resume", label: "Until I resume them" },
              { value: "date", label: "Until a date" },
            ]}
          />
        </fieldset>
        {mode === "date" ? (
          <Input label="Paused until" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} required hint="Their access comes back by itself at this time." error={error} />
        ) : (
          <p className="settings-a-hint">Like a block: their access stays off until someone chooses Resume access in their menu.</p>
        )}
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
      title={`Invite ${invite?.person.name || invite?.person.email || ""}`}
      description="This link is shown only now. It works once, for 24 hours, and only for this email."
      size="lg"
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      {invite ? (
        <div className="settings-a-stack">
          {invite.emailed ? (
            <Notice tone="good">
              Emailed to <strong>{invite.person.email}</strong>. You can also copy the link below.
            </Notice>
          ) : invite.emailProblem ? (
            <Notice tone="warn">Not emailed: {invite.emailProblem} Copy the link below and send it yourself.</Notice>
          ) : null}
          <SecretField value={invite.inviteUrl} copied="Invite link copied" label="Invite link" />
          <ol className="settings-a-steps">
            <li>
              Make sure <strong>{invite.person.email}</strong> is in your Cloudflare Access policy (<ExternalLink href={ZERO_TRUST}>Zero Trust</ExternalLink> → Access → Applications). Without it, the link can't open.
            </li>
            <li>{invite.emailed ? "They open the link" : "Send them the link"}. They sign in with that email, choose a password, and they're in.</li>
          </ol>
        </div>
      ) : null}
    </Dialog>
  );
}
