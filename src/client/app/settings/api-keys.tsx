// Settings → API keys: personal keys for scripts and tools, each limited to
// what its owner can do.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { PERMISSION_INFO, type Permission } from "../../../shared/permissions";
import type { ApiKeyDTO, MeDTO, NewApiKeyDTO } from "../../../shared/types";
import { api, call, keys } from "../../api";
import { ago, date, whenFull } from "../../lib/format";
import { SETTINGS_HELP } from "../../lib/help";
import { Badge, Button, Checkbox, Dialog, Empty, ErrorState, Input, Section, Segmented } from "../ui";
import { CodeBlock, HelpTip, RowsLoading, SecretField, toastError } from "./parts";

const EXPIRY = [
  { value: "never", label: "Never" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
] as const;
type Expiry = (typeof EXPIRY)[number]["value"];

/** What a key may do, in a few words. */
function keySummary(permissions: readonly Permission[]): string {
  return permissions.length ? permissions.map((p) => PERMISSION_INFO[p].label).join(" · ") : "View and copy links";
}

export function ApiKeysSection({ me, origin }: { me: MeDTO; origin: string }) {
  const qc = useQueryClient();
  const admin = me.role === "admin";
  const [all, setAll] = useState(false);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<NewApiKeyDTO | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyDTO | null>(null);
  const q = useQuery({ queryKey: keys.apiKeys(all), queryFn: () => call(api.keys.$get({ query: all ? { all: "1" } : {} })) });

  const revoke = useMutation({
    mutationFn: (k: ApiKeyDTO) => call(api.keys[":id"].$delete({ param: { id: k.id } })),
    onSuccess: (_, k) => {
      void qc.invalidateQueries({ queryKey: ["api-keys"] });
      void qc.invalidateQueries({ queryKey: keys.people });
      setRevoking(null);
      toast.success(`${k.name} revoked`, { description: "Anything still using it gets “invalid API key” from now on." });
    },
    onError: toastError,
  });

  const list = q.data?.keys ?? [];
  return (
    <Section
      id="api-keys"
      title="API keys"
      sub="A key lets a script, the iOS Shortcut, or a tool like Zapier or Make use Shorthop as you. It can only do what you allow, and never more than you can."
      aside={
        <>
          {admin ? (
            <Segmented
              label="Whose keys"
              size="sm"
              value={all ? "all" : "mine"}
              onChange={(v) => setAll(v === "all")}
              options={[
                { value: "mine", label: "Mine" },
                { value: "all", label: "Everyone's" },
              ]}
            />
          ) : null}
          <Button size="sm" icon={Plus} onClick={() => setCreating(true)}>
            Create API key
          </Button>
          <HelpTip help={SETTINGS_HELP.apiKeys} />
        </>
      }
    >
      {q.isPending ? (
        <RowsLoading rows={2} />
      ) : q.isError ? (
        <ErrorState what="API keys" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} compact />
      ) : list.length === 0 ? (
        <Empty compact title={all ? "Nobody has an API key yet" : "You have no API keys yet"}>
          <p>Create one for each tool that uses Shorthop, so you can revoke them one by one.</p>
        </Empty>
      ) : (
        <ul className="settings-a-list" aria-label={all ? "Everyone's API keys" : "Your API keys"}>
          {list.map((k) => (
            <li key={k.id} className="settings-a-item">
              <div className="settings-a-item-main">
                <p className="settings-a-item-title">
                  <span className="settings-a-name">{k.name}</span>
                  <code className="settings-a-mono">shp_{k.id}_…</code>
                  {k.expired ? <Badge tone="danger">Expired</Badge> : null}
                </p>
                <p className="settings-a-item-sub">
                  {all ? `${k.owner} · ` : ""}
                  {keySummary(k.permissions)}
                </p>
                <p className="settings-a-item-sub">
                  Created {date(k.createdAt)} ·{" "}
                  <span title={k.lastUsedAt ? whenFull(k.lastUsedAt) : undefined}>{k.lastUsedAt ? `last used ${ago(k.lastUsedAt)}` : "never used"}</span>
                  {k.expiresAt && !k.expired ? ` · expires ${date(k.expiresAt)}` : ""}
                </p>
              </div>
              <div className="settings-a-item-tools">
                <Button variant="ghost" size="sm" icon={Trash2} onClick={() => setRevoking(k)} aria-label={`Revoke ${k.name}`}>
                  Revoke
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {creating ? (
        <CreateKeyDialog
          me={me}
          onClose={() => setCreating(false)}
          onCreated={(k) => {
            setCreating(false);
            setCreated(k);
          }}
        />
      ) : null}
      <Dialog
        open={created !== null}
        onOpenChange={(o) => !o && setCreated(null)}
        title={`Your key “${created?.key.name ?? ""}”`}
        description="Copy it now: it's shown only once. Store it where the tool keeps secrets."
        size="lg"
        footer={
          <Button variant="primary" onClick={() => setCreated(null)}>
            Done
          </Button>
        }
      >
        {created ? <NewKey created={created} origin={origin} /> : null}
      </Dialog>
      <Dialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revoke “${revoking?.name ?? ""}”?`}
        description="Anything using this key stops working right away. This can't be undone; create a new key if you need one again."
        size="sm"
        footer={
          <>
            <Button onClick={() => setRevoking(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => revoking && revoke.mutate(revoking)} loading={revoke.isPending}>
              Revoke
            </Button>
          </>
        }
      />
    </Section>
  );
}

function CreateKeyDialog({ me, onClose, onCreated }: { me: MeDTO; onClose: () => void; onCreated: (k: NewApiKeyDTO) => void }) {
  const qc = useQueryClient();
  const formId = useId();
  // Keys can't manage keys, so "Personal API keys" isn't offered.
  const offered = me.permissions.filter((p) => p !== "api.use");
  const [name, setName] = useState("");
  const [perms, setPerms] = useState<Permission[]>(offered.includes("links.create") ? ["links.create"] : []);
  const [expiry, setExpiry] = useState<Expiry>("never");

  const create = useMutation({
    mutationFn: () => call(api.keys.$post({ json: { name, permissions: perms, expiresInDays: expiry === "never" ? null : (Number(expiry) as 30 | 90 | 365) } })),
    onSuccess: (k) => {
      void qc.invalidateQueries({ queryKey: ["api-keys"] });
      void qc.invalidateQueries({ queryKey: keys.people });
      onCreated(k);
    },
    onError: toastError,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Create an API key"
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form={formId} variant="primary" loading={create.isPending} disabled={!name.trim()}>
            Create key
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="settings-a-form">
        <Input label="Name" hint="What uses it, such as “iOS Shortcut” or “Zapier”." required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
        <fieldset className="settings-a-fieldset">
          <legend className="ui-field-label">What it may do</legend>
          <p className="settings-a-hint">Every key can list links and read their details. Tick only what the tool needs.</p>
          {offered.length ? (
            <div className="settings-a-checks">
              {offered.map((p) => (
                <Checkbox
                  key={p}
                  label={PERMISSION_INFO[p].label}
                  description={PERMISSION_INFO[p].description}
                  checked={perms.includes(p)}
                  onCheckedChange={(on) => setPerms((list) => (on ? [...list, p] : list.filter((x) => x !== p)))}
                />
              ))}
            </div>
          ) : null}
        </fieldset>
        <fieldset className="settings-a-fieldset">
          <legend className="ui-field-label">Stops working after</legend>
          <Segmented label="Stops working after" value={expiry} onChange={setExpiry} options={[...EXPIRY]} />
        </fieldset>
      </form>
    </Dialog>
  );
}

function NewKey({ created, origin }: { created: NewApiKeyDTO; origin: string }) {
  const canCreate = created.key.permissions.includes("links.create");
  const example = canCreate
    ? `curl -X POST "${origin}/api/links?format=text" \\
  -H "Authorization: Bearer ${created.secret}" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://example.com/new-post"}'`
    : `curl "${origin}/api/links" \\
  -H "Authorization: Bearer ${created.secret}"`;
  return (
    <div className="settings-a-stack">
      <SecretField value={created.secret} copied="API key copied" label="Your new API key" />
      <p className="settings-a-prose">
        Send it as the header <code className="settings-a-mono">Authorization: Bearer {"<key>"}</code>. In a tool such as Zapier, Make or n8n, use an HTTP request step with that header and the base URL{" "}
        <code className="settings-a-mono">{origin}/api</code>.
      </p>
      <CodeBlock title={canCreate ? "Create a link from a terminal" : "List your links from a terminal"} code={example} copied="Command copied" />
    </div>
  );
}
