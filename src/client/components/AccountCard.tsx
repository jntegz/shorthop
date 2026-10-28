import { useMutation } from "@tanstack/react-query";
import { LogOut, UserRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ROLE_INFO } from "../../shared/permissions";
import type { MeDTO } from "../../shared/types";
import { api, call } from "../api";
import { when } from "../lib/format";
import { Badge, Button, Card, CardHeader, Dialog, Field, Input } from "./ui";
import { permissionSummary } from "./PeopleCard";

const MIN_PASSWORD = 12;

/** Settings → My account: who you are, what you may do, your password. */
export function AccountCard({ me }: { me: MeDTO }) {
  const [changing, setChanging] = useState(false);
  // Without Access there's no email: the identity is the fixed "admin".
  const passwordOnly = me.authMode === "password";
  return (
    <Card id="account" className="scroll-mt-6 lg:col-span-2">
      <CardHeader title="My account" description="Who you're signed in as and what you may do here." />
      <div className="grid gap-6 px-4 pb-4 text-sm md:grid-cols-2">
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
              <UserRound className="size-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-1.5 font-medium text-fg">
                <span className="truncate">{passwordOnly ? "Admin" : me.name || me.email}</span>
                <Badge tone="accent">{me.owner ? "Owner" : ROLE_INFO[me.role].label}</Badge>
              </p>
              {me.name && !passwordOnly ? <p className="truncate text-xs text-muted">{me.email}</p> : null}
            </div>
          </div>
          <div className="flex items-start justify-between gap-3">
            <span className="text-muted">You may</span>
            <span className="text-right font-medium text-fg">{permissionSummary(me.role, me.permissions)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted">Session ends</span>
            <span className="font-medium text-fg">{me.sessionExpiresAt ? when(me.sessionExpiresAt) : "—"}</span>
          </div>
        </div>
        <div className="space-y-3">
          {me.owner ? (
            <p className="text-muted">
              {passwordOnly ? "Without Cloudflare Access, everyone who knows the admin password signs in as the owner." : "As an owner (ADMIN_EMAIL) you sign in with the admin password."}{" "}
              Change it with <code className="font-mono text-xs text-fg">npm run setup -- password</code>, which also ends every session.
            </p>
          ) : (
            <p className="text-muted">Your password is the second lock after Cloudflare Access. Changing it signs you out on your other devices.</p>
          )}
          <div className="flex flex-wrap gap-2">
            {!me.owner && me.passwordConfigured ? (
              <Button variant="outline" onClick={() => setChanging(true)}>
                Change password
              </Button>
            ) : null}
            <form method="post" action="/_admin/logout">
              <Button type="submit" variant="outline">
                <LogOut /> Log out
              </Button>
            </form>
          </div>
        </div>
      </div>
      {changing ? <PasswordDialog email={me.email} onClose={() => setChanging(false)} /> : null}
    </Card>
  );
}

function PasswordDialog({ email, onClose }: { email: string; onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const problem = next && next.length < MIN_PASSWORD ? `Use at least ${MIN_PASSWORD} characters.` : repeat && repeat !== next ? "The two passwords don't match." : null;
  const save = useMutation({
    mutationFn: () => call(api.me.password.$post({ json: { current, next } })),
    onSuccess: () => {
      toast.success("Password changed", { description: "You stay signed in here; other devices need the new password." });
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!problem) save.mutate();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Change your password">
      <form onSubmit={submit} className="space-y-4">
        <input type="email" name="username" value={email} autoComplete="username" readOnly hidden />
        <Field label="Current password" htmlFor="pw-current">
          <Input id="pw-current" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus />
        </Field>
        <Field label="New password" htmlFor="pw-next" hint={`At least ${MIN_PASSWORD} characters.`}>
          <Input id="pw-next" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD} maxLength={1024} value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label="Repeat it" htmlFor="pw-repeat" error={problem}>
          <Input id="pw-repeat" type="password" autoComplete="new-password" required value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={save.isPending} disabled={Boolean(problem) || !current || !next || next !== repeat}>
            Change password
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
