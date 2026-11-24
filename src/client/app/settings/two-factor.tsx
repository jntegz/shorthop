// Settings → Access & security → Two-factor sign-in (#two-factor): each
// person's own second step after the password. An authenticator app, passkeys
// (which also sign in on their own, without the password) and recovery codes
// for a lost phone. Changes need a sign-in at most REAUTH_WINDOW_SEC old;
// older sessions are sent to sign in again first.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { browserSupportsWebAuthn, startRegistration, type PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import QRCode from "qrcode";
import { Copy, Download, Fingerprint, KeyRound, Pencil, Plus, ShieldCheck, Smartphone } from "lucide-react";
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { z } from "zod";
import type { passkeyRegisterSchema } from "../../../shared/schemas";
import type { MeDTO, TwoFactorDTO, TwoFactorFactorDTO } from "../../../shared/types";
import { api, ApiError, call, keys } from "../../api";
import { ago, whenFull } from "../../lib/format";
import { SETTINGS_HELP } from "../../lib/help";
import { Badge, Button, Checkbox, Dialog, ErrorState, Input, Notice, Section } from "../ui";
import { HelpTip, RowsLoading, toastError } from "./parts";

const REAUTH_URL = `/_admin/login?reauth=1&next=${encodeURIComponent("/_admin/settings#two-factor")}`;

const isReauth = (err: unknown) => err instanceof ApiError && (err.body as { code?: string } | undefined)?.code === "reauth_required";

export function TwoFactorSection({ me }: { me: MeDTO }) {
  const qc = useQueryClient();
  const usable = me.via === "session" && me.passwordConfigured;
  const q = useQuery({ queryKey: keys.twoFactor, queryFn: () => call(api.me.security.$get()), enabled: usable });
  const [settingUp, setSettingUp] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [removing, setRemoving] = useState<TwoFactorFactorDTO | null>(null);
  const [renaming, setRenaming] = useState<TwoFactorFactorDTO | null>(null);
  const [addingPasskey, setAddingPasskey] = useState(false);
  const [reauth, setReauth] = useState(false);
  const webauthn = useMemo(() => browserSupportsWebAuthn(), []);

  const onError = (err: unknown) => (isReauth(err) ? setReauth(true) : toastError(err));
  const refresh = (t: TwoFactorDTO) => qc.setQueryData(keys.twoFactor, t);

  const newCodes = useMutation({
    mutationFn: () => call(api.me["recovery-codes"].$post()),
    onSuccess: (r) => {
      refresh(r.twoFactor);
      setCodes(r.recoveryCodes);
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: (f: TwoFactorFactorDTO) => call(api.me.factors[":id"].$delete({ param: { id: f.id } })),
    onSuccess: (t) => {
      refresh(t);
      setRemoving(null);
      toast.success("Removed", { description: t.factors.length ? "Your other sessions ended." : "Your password alone signs you in again. Your other sessions ended." });
    },
    onError: (err) => {
      setRemoving(null);
      onError(err);
    },
  });

  // The server decides whether this sign-in is recent enough: a reauth_required answer opens "Sign in again".

  const t = q.data;
  const totp = t?.factors.find((f) => f.kind === "totp");
  const passkeys = t?.factors.filter((f) => f.kind === "passkey") ?? [];
  const on = Boolean(t?.factors.length);
  const confirmed = (r: Confirmed, what: string) => {
    refresh(r.twoFactor);
    if (r.recoveryCodes) setCodes(r.recoveryCodes);
    toast.success(what, { description: "Your other sessions ended." });
  };

  return (
    <Section
      id="two-factor"
      title="Two-factor sign-in"
      sub="A code from an app on your phone after your password, or a passkey instead of it. Someone who learns your password still can't sign in."
      aside={<HelpTip help={SETTINGS_HELP.twoFactor} />}
    >
      {!usable ? (
        <p className="settings-a-prose">
          {me.passwordConfigured
            ? "Available when you're signed in with your password, not with an API key."
            : "Two-factor sign-in works with the admin password login. Set the admin password first (npm run setup -- password, or the ADMIN_PASSWORD secret)."}
        </p>
      ) : q.isPending ? (
        <RowsLoading rows={2} />
      ) : q.isError ? (
        <ErrorState what="Two-factor sign-in" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} compact />
      ) : t ? (
        <div className="settings-a-two is-wide-first">
          <div className="settings-a-stack">
            {t.required && !on ? (
              <Notice tone="warn" title="Required by an admin">
                Set it up now. Your next login asks for it either way.
              </Notice>
            ) : null}
            <ul className="settings-a-list" aria-label="Sign-in methods">
              <li className="settings-a-item">
                <span className="settings-a-avatar" aria-hidden>
                  <Smartphone />
                </span>
                <div className="settings-a-item-main">
                  <p className="settings-a-item-title">
                    <span className="settings-a-name">Authenticator app</span>
                    {totp ? <Badge tone="good">On</Badge> : <Badge>Off</Badge>}
                  </p>
                  <p className="settings-a-item-sub">{totp ? used(totp) : "1Password, Google Authenticator, Authy or any app that shows 6-digit codes."}</p>
                </div>
                <div className="settings-a-item-tools">
                  {totp ? (
                    <Button size="sm" onClick={() => setRemoving(totp)}>
                      Remove
                    </Button>
                  ) : (
                    <Button size="sm" variant="primary" onClick={() => setSettingUp(true)}>
                      Set up
                    </Button>
                  )}
                </div>
              </li>
              {passkeys.map((f) => (
                <li key={f.id} className="settings-a-item">
                  <span className="settings-a-avatar" aria-hidden>
                    <Fingerprint />
                  </span>
                  <div className="settings-a-item-main">
                    <p className="settings-a-item-title">
                      <span className="settings-a-name">{f.name}</span>
                      <span className="settings-a-role">Passkey</span>
                    </p>
                    <p className="settings-a-item-sub">{used(f)}</p>
                  </div>
                  <div className="settings-a-item-tools">
                    <Button size="sm" icon={Pencil} onClick={() => setRenaming(f)}>
                      Rename
                    </Button>
                    <Button size="sm" onClick={() => setRemoving(f)}>
                      Remove
                    </Button>
                  </div>
                </li>
              ))}
              <li className="settings-a-item">
                <span className="settings-a-avatar" aria-hidden>
                  <Fingerprint />
                </span>
                <div className="settings-a-item-main">
                  <p className="settings-a-item-title">
                    <span className="settings-a-name">{passkeys.length ? "Another passkey" : "Passkey"}</span>
                  </p>
                  <p className="settings-a-item-sub">
                    {webauthn
                      ? "Sign in with your fingerprint, face or device PIN, without the password. Works on this admin host only."
                      : "This browser can't make passkeys."}
                  </p>
                </div>
                <div className="settings-a-item-tools">
                  <Button size="sm" icon={Plus} variant={on ? "secondary" : "primary"} onClick={() => setAddingPasskey(true)} disabled={!webauthn}>
                    Add a passkey
                  </Button>
                </div>
              </li>
              {on ? (
                <li className="settings-a-item">
                  <span className="settings-a-avatar" aria-hidden>
                    <KeyRound />
                  </span>
                  <div className="settings-a-item-main">
                    <p className="settings-a-item-title">
                      <span className="settings-a-name">Recovery codes</span>
                      {t.recoveryLeft <= 2 ? <Badge tone="warn">{t.recoveryLeft} left</Badge> : null}
                    </p>
                    <p className="settings-a-item-sub">
                      {t.recoveryLeft} unused. Each signs you in once without your phone.
                    </p>
                  </div>
                  <div className="settings-a-item-tools">
                    <Button size="sm" onClick={() => newCodes.mutate()} loading={newCodes.isPending}>
                      Make new codes
                    </Button>
                  </div>
                </li>
              ) : null}
            </ul>
          </div>
          <div className="settings-a-guide">
            <p className="settings-a-lead">
              <ShieldCheck aria-hidden />
              {!on
                ? "Your password alone signs you in."
                : totp && passkeys.length
                  ? "You sign in with a passkey, or with your password and a code."
                  : passkeys.length
                    ? "You sign in with a passkey, or with your password and a recovery code."
                    : "Your login asks for a code after the password."}
            </p>
            <p className="settings-a-prose">
              Lost your phone and your recovery codes? {me.owner ? "Owners follow the steps in docs/SETUP.md (Two-factor sign-in)." : "An admin can reset your two-factor sign-in in People."} Changes end your
              other sessions and need a sign-in from the last {Math.round(t.reauthWindowSec / 60)} minutes.
            </p>
          </div>
        </div>
      ) : null}

      {settingUp ? (
        <TotpSetupDialog
          email={me.email}
          onClose={() => setSettingUp(false)}
          onReauth={() => (setSettingUp(false), setReauth(true))}
          onDone={(r) => {
            setSettingUp(false);
            confirmed(r, "Authenticator app added");
          }}
        />
      ) : null}
      {addingPasskey ? (
        <PasskeyDialog
          onClose={() => setAddingPasskey(false)}
          onReauth={() => (setAddingPasskey(false), setReauth(true))}
          onDone={(r) => {
            setAddingPasskey(false);
            confirmed(r, "Passkey added");
          }}
        />
      ) : null}
      {renaming ? <RenameDialog factor={renaming} onClose={() => setRenaming(null)} onDone={(t2) => (refresh(t2), setRenaming(null))} /> : null}
      {codes ? <RecoveryCodesDialog codes={codes} email={me.email} onClose={() => setCodes(null)} /> : null}
      <Dialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={removing?.kind === "passkey" ? `Remove the passkey “${removing.name}”?` : "Remove your authenticator app?"}
        description={
          t && t.factors.length === 1
            ? "Two-factor sign-in turns off: your password alone signs you in, and your recovery codes stop working. Your other sessions end."
            : removing?.kind === "passkey"
              ? "It can't sign you in any more. Also delete it from the device or password manager. Your other sessions end."
              : "Codes from it stop working. Your other sessions end."
        }
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
      <Dialog
        open={reauth}
        onOpenChange={setReauth}
        title="Sign in again first"
        description={`For your safety, changes to two-factor sign-in need a sign-in from the last ${Math.round((t?.reauthWindowSec ?? 900) / 60)} minutes. You come back here afterwards.`}
        size="sm"
        footer={
          <>
            <Button onClick={() => setReauth(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => window.location.assign(REAUTH_URL)}>
              Sign in again
            </Button>
          </>
        }
      />
    </Section>
  );
}

function used(f: TwoFactorFactorDTO): string {
  return `Added ${ago(f.createdAt)}${f.lastUsedAt && f.lastUsedAt !== f.createdAt ? ` · last used ${ago(f.lastUsedAt)}` : ""}`;
}

/** The QR code an authenticator app scans: dark on white, whatever the theme. */
function QrCode({ text, label }: { text: string; label: string }) {
  const { d, size } = useMemo(() => {
    const { modules } = QRCode.create(text, { errorCorrectionLevel: "M" });
    const n = modules.size;
    let path = "";
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (modules.get(y, x)) path += `M${x + 4} ${y + 4}h1v1h-1z`;
    return { d: path, size: n + 8 };
  }, [text]);
  return (
    <svg className="settings-a-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

type Confirmed = { twoFactor: TwoFactorDTO; recoveryCodes: string[] | null };

/** The browser's answer as the API's schema types it (passkeyRegisterSchema). */
type PasskeyAnswer = z.input<typeof passkeyRegisterSchema>["response"];

function TotpSetupDialog({ email, onClose, onDone, onReauth }: { email: string; onClose: () => void; onDone: (r: Confirmed) => void; onReauth: () => void }) {
  const formId = useId();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const start = useQuery({ queryKey: ["two-factor-setup"], queryFn: () => call(api.me.totp.setup.$post()), retry: false, gcTime: 0, staleTime: Infinity });
  const confirm = useMutation({
    mutationFn: () => call(api.me.totp.confirm.$post({ json: { code, name: name || undefined } })),
    onSuccess: onDone,
    onError: (err) => (isReauth(err) ? onReauth() : toastError(err)),
  });
  const needsReauth = start.isError && isReauth(start.error);
  useEffect(() => {
    if (needsReauth) onReauth();
  }, [needsReauth, onReauth]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (code.trim()) confirm.mutate();
  };
  const secret = start.data?.secret.replace(/(.{4})/g, "$1 ").trim();
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Set up an authenticator app"
      description="Scan the code with the app, then enter the 6-digit code it shows."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form={formId} variant="primary" loading={confirm.isPending} disabled={!start.data || !code.trim()}>
            Turn on
          </Button>
        </>
      }
    >
      {start.isPending ? (
        <RowsLoading rows={3} />
      ) : start.isError ? (
        needsReauth ? null : <ErrorState what="Setup" error={start.error} onRetry={() => void start.refetch()} compact />
      ) : start.data ? (
        <form id={formId} onSubmit={submit} className="settings-a-form">
          <QrCode text={start.data.uri} label={`QR code to add ${email} to an authenticator app`} />
          <details className="settings-a-details">
            <summary>Can't scan it? Enter the key by hand</summary>
            <p className="settings-a-mono settings-a-key">{secret}</p>
          </details>
          <Input
            label="Code from the app"
            inputMode="numeric"
            autoComplete="one-time-code"
            className="settings-a-mono-field"
            required
            maxLength={10}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <Input label="Name (optional)" placeholder="Authenticator app" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} hint="Helps you tell it apart later." />
          <input type="email" name="username" value={email} autoComplete="username" readOnly hidden />
        </form>
      ) : null}
    </Dialog>
  );
}

/** A name for a new passkey, from this device and browser ("Mac · Safari"). */
function suggestedName(): string {
  const ua = navigator.userAgent;
  const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return [device, browser].filter(Boolean).join(" · ") || "Passkey";
}

function PasskeyDialog({ onClose, onDone, onReauth }: { onClose: () => void; onDone: (r: Confirmed) => void; onReauth: () => void }) {
  const formId = useId();
  const [name, setName] = useState(suggestedName);
  const add = useMutation({
    mutationFn: async () => {
      const { options } = await call(api.me.passkeys.options.$post());
      // The server made these with the same library; JSON typing just can't tell.
      const response = await startRegistration({ optionsJSON: options as unknown as PublicKeyCredentialCreationOptionsJSON });
      return call(api.me.passkeys.$post({ json: { response: response as unknown as PasskeyAnswer, name: name.trim() || undefined } }));
    },
    onSuccess: onDone,
    onError: (err) => {
      if (isReauth(err)) return onReauth();
      if (err instanceof Error && (err.name === "NotAllowedError" || err.name === "AbortError")) return toast.error("Cancelled", { description: "No passkey was added." });
      if (err instanceof Error && err.name === "InvalidStateError") return toast.error("This device already has a passkey here");
      toastError(err);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add a passkey"
      description="Your browser asks for your fingerprint, face, device PIN or a security key. The passkey stays on your device or in your password manager; only its public key is stored here."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form={formId} variant="primary" loading={add.isPending}>
            Continue
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="settings-a-form">
        <Input label="Name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} hint="Where it lives, so you can tell it apart later." />
      </form>
    </Dialog>
  );
}

function RenameDialog({ factor, onClose, onDone }: { factor: TwoFactorFactorDTO; onClose: () => void; onDone: (t: TwoFactorDTO) => void }) {
  const formId = useId();
  const [name, setName] = useState(factor.name);
  const save = useMutation({
    mutationFn: () => call(api.me.factors[":id"].$patch({ param: { id: factor.id }, json: { name } })),
    onSuccess: onDone,
    onError: toastError,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) save.mutate();
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Rename"
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form={formId} variant="primary" loading={save.isPending} disabled={!name.trim()}>
            Save
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="settings-a-form">
        <Input label="Name" required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
      </form>
    </Dialog>
  );
}

/** New recovery codes: shown once, so closing needs a tick that they're saved. */
function RecoveryCodesDialog({ codes, email, onClose }: { codes: string[]; email: string; onClose: () => void }) {
  const [saved, setSaved] = useState(false);
  const text = `Shorthop recovery codes for ${email}\nMade ${whenFull(Math.floor(Date.now() / 1000))}. Each works once.\n\n${codes.join("\n")}\n`;
  const copy = () =>
    void navigator.clipboard.writeText(text).then(
      () => toast.success("Codes copied"),
      () => toast.error("Couldn't copy. Select them and copy by hand."),
    );
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "shorthop-recovery-codes.txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && saved && onClose()}
      title="Save your recovery codes"
      description="If you lose your phone, each code signs you in once. They won't be shown again, and any older codes stopped working."
      footer={
        <Button variant="primary" onClick={onClose} disabled={!saved}>
          Done
        </Button>
      }
    >
      <div className="settings-a-form">
        <ul className="settings-a-codes settings-a-mono" aria-label="Recovery codes">
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <div className="settings-a-actions">
          <Button size="sm" icon={Copy} onClick={copy}>
            Copy
          </Button>
          <Button size="sm" icon={Download} onClick={download}>
            Download .txt
          </Button>
        </div>
        <Checkbox label="I saved them somewhere safe" checked={saved} onCheckedChange={setSaved} />
      </div>
    </Dialog>
  );
}
