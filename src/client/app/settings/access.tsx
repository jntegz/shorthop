// Settings → Access & security. The page shell (Settings.tsx) imports these
// sections; keep their names and props.
//   AccountSection    (#account)
//   AppearanceSection (#appearance)
//   PeopleSection     (#people)     → people.tsx
//   SecuritySection   (#security)
//   BotCheckSection   (#bot-check)

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Check, LogOut, UserRound } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { MeDTO, SecurityDTO } from "../../../shared/types";
import { api, call, keys } from "../../api";
import { ACCENTS, saveAccent, savedAccent } from "../../lib/accent";
import { countryName, flag, num, when } from "../../lib/format";
import { SETTINGS_HELP } from "../../lib/help";
import { saveTheme, useTheme, type Theme } from "../../lib/theme";
import { Badge, Button, Dialog, ErrorState, Input, Notice, Section, Segmented } from "../ui";
import { ExternalLink, Fact, Facts, HelpTip, RowsLoading, toastError } from "./parts";
import { permissionSummary, roleLabel } from "./people";

export { PeopleSection, permissionSummary } from "./people";

const MIN_PASSWORD = 12;
const TURNSTILE_DASHBOARD = "https://dash.cloudflare.com/?to=/:account/turnstile";

// ---- My account ----

/** Who you are, what you may do, your password. */
export function AccountSection({ me }: { me: MeDTO }) {
  const [changing, setChanging] = useState(false);
  // Without Access there's no email: the identity is the fixed "admin".
  const passwordOnly = me.authMode === "password";
  return (
    <Section id="account" title="My account" sub="Who you're signed in as and what you may do here.">
      <div className="settings-a-two">
        <div>
          <div className="settings-a-who">
            <span className="settings-a-avatar is-lg" aria-hidden>
              <UserRound />
            </span>
            <div className="settings-a-item-main">
              <p className="settings-a-item-title">
                <span className="settings-a-name">{passwordOnly ? "Admin" : me.name || me.email}</span>
                <span className="settings-a-role">{roleLabel(me)}</span>
              </p>
              {me.name && !passwordOnly ? <p className="settings-a-item-sub settings-a-ellipsis">{me.email}</p> : null}
            </div>
          </div>
          <Facts>
            <Fact label="You may">{permissionSummary(me.role, me.permissions)}</Fact>
            <Fact label="Session ends">{me.sessionExpiresAt ? when(me.sessionExpiresAt) : "—"}</Fact>
          </Facts>
        </div>
        <div className="settings-a-stack">
          {me.owner ? (
            <p className="settings-a-prose">
              {passwordOnly ? "Without Cloudflare Access, everyone who knows the admin password signs in as the owner." : "As an owner (ADMIN_EMAIL) you sign in with the admin password."} Change it
              with <code className="settings-a-mono">npm run setup -- password</code>, which also ends every session.
            </p>
          ) : (
            <p className="settings-a-prose">Your password is the second lock after Cloudflare Access. Changing it signs you out on your other devices.</p>
          )}
          <div className="settings-a-actions">
            {!me.owner && me.passwordConfigured ? <Button onClick={() => setChanging(true)}>Change password</Button> : null}
            <form method="post" action="/_admin/logout">
              <Button type="submit" icon={LogOut}>
                Log out
              </Button>
            </form>
          </div>
        </div>
      </div>
      {changing ? <PasswordDialog email={me.email} onClose={() => setChanging(false)} /> : null}
    </Section>
  );
}

function PasswordDialog({ email, onClose }: { email: string; onClose: () => void }) {
  const formId = useId();
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
    onError: toastError,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!problem) save.mutate();
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Change your password"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form={formId} variant="primary" loading={save.isPending} disabled={Boolean(problem) || !current || !next || next !== repeat}>
            Change password
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="settings-a-form">
        <Input label="Current password" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        <Input
          label="New password"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD}
          maxLength={1024}
          value={next}
          onChange={(e) => setNext(e.target.value)}
          hint={`At least ${MIN_PASSWORD} characters.`}
        />
        <Input label="Repeat it" type="password" autoComplete="new-password" required value={repeat} onChange={(e) => setRepeat(e.target.value)} error={problem} />
        {/* For password managers; after the fields so the dialog opens on "Current password". */}
        <input type="email" name="username" value={email} autoComplete="username" readOnly hidden />
      </form>
    </Dialog>
  );
}

// ---- Appearance ----

/** Light or dark, and the accent colour: for this person in this browser. */
export function AppearanceSection() {
  const [color, setColor] = useState(savedAccent);
  const pick = (c: string) => (saveAccent(c), setColor(c));
  const custom = !ACCENTS.some((a) => a.color === color);
  const theme = useTheme();
  const accentLabel = useId();
  return (
    <Section id="appearance" title="Appearance" sub="Light or dark, and the accent colour for buttons, links and charts. Saved in this browser, just for you.">
      <div className="settings-a-form">
        <fieldset className="settings-a-fieldset">
          <legend className="ui-field-label">Theme</legend>
          <Segmented<Theme>
            label="Theme"
            value={theme}
            onChange={saveTheme}
            options={[
              { value: "auto", label: "Automatic" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </fieldset>
        <div className="settings-a-fieldset">
          <p className="ui-field-label" id={accentLabel}>
            Accent colour
          </p>
          <div role="radiogroup" aria-labelledby={accentLabel} className="settings-a-swatches">
            {ACCENTS.map((a) => {
              const on = color === a.color;
              return (
                <button key={a.id} type="button" role="radio" aria-checked={on} onClick={() => pick(a.color)} className="settings-a-swatch">
                  <span className="settings-a-dot" style={{ background: a.color }}>
                    {on ? <Check aria-hidden /> : null}
                  </span>
                  {a.label}
                </button>
              );
            })}
            <label className="settings-a-swatch" data-checked={custom ? "" : undefined}>
              <input type="color" value={color} onChange={(e) => pick(e.target.value)} className="settings-a-color" aria-describedby={accentLabel} />
              Custom{custom ? <span className="ui-sr"> (chosen)</span> : null}
            </label>
          </div>
        </div>
      </div>
    </Section>
  );
}

// ---- People, without Access ----

/** People need Access to tell them apart; with password-only sign-in there are only owners. */
export function PasswordOnlyPeople() {
  return (
    <Section id="people" title="People" sub="Give others their own sign-in and permissions." aside={<HelpTip help={SETTINGS_HELP.people} />}>
      <p className="settings-a-prose">
        Cloudflare Access is off, so everyone who knows the admin password signs in as the owner, and history can't tell people apart. Turn on Cloudflare Access with{" "}
        <code className="settings-a-mono">npm run setup -- access</code> to add people with their own passwords and permissions.
      </p>
    </Section>
  );
}

// ---- Security ----

/** Admins, when the settings carry security data. Owns "Log out everyone" and its confirm. */
export function SecuritySection({ me, security }: { me: MeDTO; security: SecurityDTO }) {
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const revoke = useMutation({
    mutationFn: () => call(api.settings.sessions.revoke.$post()),
    onSuccess: () => window.location.assign("/_admin/login"),
    onError: toastError,
  });
  const s = security;
  return (
    <Section
      id="security"
      title="Security"
      sub={s.mode === "password" ? "Your admin password is the only lock: Cloudflare Access is off." : "Cloudflare Access checks who someone is; their password confirms it."}
      aside={<HelpTip help={SETTINGS_HELP.security} />}
    >
      <div className="settings-a-two">
        <div className="settings-a-stack">
          {!me.passwordConfigured ? (
            <Notice tone="warn">
              No admin password is set, so localhost opens without one. The deployed admin stays closed until ADMIN_PASSWORD_HASH is set. To try the login here: run{" "}
              <code className="settings-a-mono">npm run setup -- local</code> (or <code className="settings-a-mono">npx tsx scripts/hash-password.ts --generate</code> and add{" "}
              <code className="settings-a-mono">ADMIN_PASSWORD_HASH=…</code> and <code className="settings-a-mono">SESSION_SECRET=…</code> to .dev.vars), then restart npm run dev.
            </Notice>
          ) : null}
          {s.globalLockedUntil ? <Notice tone="danger">All logins are paused until {when(s.globalLockedUntil)} after many failed attempts.</Notice> : null}
          {s.mode === "password" ? (
            <Notice tone="warn" title="Cloudflare Access is off">
              Anyone who finds this page can try passwords, slowed only by the lockout. Use a long, random password and add the rate-limit rule from SECURITY.md, or turn Access on with{" "}
              <code className="settings-a-mono">npm run setup -- access</code>.{s.accessConfigured ? " Access settings are filled in, but ignored while ADMIN_AUTH is \"password\"." : null}
            </Notice>
          ) : null}
          <Facts>
            <Fact label="Sign-in">{s.mode === "password" ? "Admin password only" : "Cloudflare Access + password"}</Fact>
            <Fact label="Failed logins (24 h)">
              {s.failedLogins24h ? <Badge tone="warn">{num(s.failedLogins24h)}</Badge> : <span className="settings-a-num">0</span>}
            </Fact>
            <Fact label="Locked networks">
              <span className="settings-a-num">{num(s.lockedNetworks)}</span>
            </Fact>
          </Facts>
          <div className="settings-a-actions">
            <Button onClick={() => setConfirmRevoke(true)} disabled={!me.passwordConfigured} title={me.passwordConfigured ? undefined : "Needs an admin password (ADMIN_PASSWORD_HASH)"}>
              Log out everyone
            </Button>
          </div>
        </div>
        <div>
          <h3 className="settings-a-h3">Recent logins</h3>
          {s.recent.length ? (
            <ul className="settings-a-logins" aria-label="Recent logins">
              {s.recent.map((e, i) => (
                <li key={`${e.at}-${i}`}>
                  <span className="settings-a-login-result">{e.ok ? <span className="settings-a-ok">Success</span> : <Badge tone="danger">Failed</Badge>}</span>
                  <span className="settings-a-login-when">{when(e.at)}</span>
                  <span className="settings-a-login-where">{e.country ? `${flag(e.country)} ${countryName(e.country)}` : "Unknown"}</span>
                  {e.email && e.email !== "admin" ? <span className="settings-a-login-who settings-a-ellipsis">{e.email}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="settings-a-prose">No logins recorded yet.</p>
          )}
        </div>
      </div>
      <Dialog
        open={confirmRevoke}
        onOpenChange={setConfirmRevoke}
        title="Log out everyone?"
        description="Every session of every person ends now, including this one. Everyone needs their password again on every device."
        size="sm"
        footer={
          <>
            <Button onClick={() => setConfirmRevoke(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => revoke.mutate()} loading={revoke.isPending}>
              Log out everyone
            </Button>
          </>
        }
      />
    </Section>
  );
}

// ---- Bot check ----

/**
 * The optional Cloudflare Turnstile check on the password pages (admins). Off
 * by default; it turns on only after a test passes.
 */
export function BotCheckSection() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: keys.turnstile, queryFn: () => call(api.settings.turnstile.$get()) });
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const key = siteKey ?? q.data?.siteKey ?? "";

  const save = useMutation({
    mutationFn: () => call(api.settings.turnstile.$put({ json: { siteKey: key } })),
    onSuccess: (data) => {
      qc.setQueryData(keys.turnstile, data);
      setSiteKey(null);
      toast.success("Site key saved", { description: data.secretSet ? "Now test it to turn the check on." : "Set TURNSTILE_SECRET next, then test it." });
    },
    onError: toastError,
  });
  const turnOff = useMutation({
    mutationFn: () => call(api.settings.turnstile.$delete()),
    onSuccess: (data) => {
      qc.setQueryData(keys.turnstile, data);
      toast.success("Bot check turned off");
    },
    onError: toastError,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  const d = q.data;
  const dirty = d ? key.trim() !== d.siteKey : false;
  return (
    <Section
      id="bot-check"
      title="Bot check"
      sub="Optional Cloudflare Turnstile on the login, forgot-password, invite and reset pages. Off unless you turn it on."
      aside={
        <>
          {d ? d.enabled ? <Badge tone="good">On</Badge> : <Badge>Off</Badge> : null}
          <HelpTip help={SETTINGS_HELP.botCheck} />
        </>
      }
    >
      {q.isPending ? (
        <RowsLoading rows={2} />
      ) : q.isError || !d ? (
        <ErrorState what="The bot check" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} compact />
      ) : (
        <div className="settings-a-two">
          <div className="settings-a-stack">
            <p className="settings-a-lead">
              <Bot aria-hidden />
              <span>
                Cloudflare Access already keeps bots away from these pages, and wrong passwords and reset requests are limited. Turn this on only if your Access policy lets many people in (for example any email
                with a one-time PIN).
              </span>
            </p>
            <form onSubmit={submit} className="settings-a-form">
              <Input
                label="Site key"
                className="settings-a-mono-field"
                placeholder="0x4AAAAAAA…"
                value={key}
                onChange={(e) => setSiteKey(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                hint="Public. From your Turnstile widget in the Cloudflare dashboard."
              />
              <Facts>
                <Fact label="Secret key (TURNSTILE_SECRET)">{d.secretSet ? "Set" : <Badge tone="warn">Not set</Badge>}</Fact>
              </Facts>
              <div className="settings-a-actions">
                {dirty || !d.siteKey ? (
                  <Button type="submit" loading={save.isPending} disabled={!key.trim()}>
                    Save site key
                  </Button>
                ) : null}
                {!dirty && d.siteKey && d.secretSet && !d.enabled ? (
                  // A server page: the widget's script isn't allowed in the admin itself.
                  <Button asChild variant="primary">
                    <a href="/_admin/bot-check">Test and turn on</a>
                  </Button>
                ) : null}
                {d.enabled ? (
                  <Button onClick={() => turnOff.mutate()} loading={turnOff.isPending}>
                    Turn off
                  </Button>
                ) : null}
              </div>
              {dirty && d.enabled ? <p className="settings-a-hint">Saving a new site key turns the check off until you test it again.</p> : null}
            </form>
          </div>
          <div>
            <h3 className="settings-a-h3">Set it up</h3>
            <ol className="settings-a-steps">
              <li>
                In the <ExternalLink href={TURNSTILE_DASHBOARD}>Cloudflare dashboard</ExternalLink> → Turnstile → <strong>Add widget</strong>. Hostname: <code className="settings-a-mono">{d.hostname}</code>. Widget mode:
                Managed.
              </li>
              <li>Paste its site key here and save.</li>
              <li>
                Store its secret key: <code className="settings-a-mono">npx wrangler secret put TURNSTILE_SECRET</code>
              </li>
              <li>
                Press <strong>Test and turn on</strong> and complete the check. It turns on only if Cloudflare confirms it, so a wrong key can't lock anyone out.
              </li>
            </ol>
          </div>
        </div>
      )}
    </Section>
  );
}
