import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { PERMISSION_INFO, type Permission } from "../../shared/permissions";
import type { ApiKeyDTO, MeDTO, NewApiKeyDTO } from "../../shared/types";
import { api, call, keys } from "../api";
import { ago, date, whenFull } from "../lib/format";
import { SETTINGS_HELP } from "../lib/help";
import { copy } from "../lib/utils";
import { Badge, Button, Card, CardHeader, Dialog, Empty, Field, Input, Notice, Segmented, Spinner } from "./ui";

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

/** Settings → API keys: personal keys for scripts and tools, each limited to what its owner can do. */
export function ApiKeys({ me, origin }: { me: MeDTO; origin: string }) {
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
    onError: (e) => toast.error(e.message),
  });

  const list = q.data?.keys ?? [];
  return (
    <Card id="api-keys" className="scroll-mt-6 lg:col-span-2">
      <CardHeader
        title="API keys"
        description="A key lets a script, the iOS Shortcut, or a tool like Zapier or Make use Shorthop as you. It can only do what you allow, and never more than you can."
        info={SETTINGS_HELP.apiKeys}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {admin ? (
              <Segmented
                label="Whose keys"
                value={all ? "all" : "mine"}
                onChange={(v) => setAll(v === "all")}
                options={[
                  { value: "mine", label: "Mine" },
                  { value: "all", label: "Everyone's" },
                ]}
              />
            ) : null}
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus /> Create API key
            </Button>
          </div>
        }
      />
      <div className="px-4 pb-4">
        {q.isPending ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : q.isError ? (
          <Notice tone="danger">{q.error.message}</Notice>
        ) : list.length === 0 ? (
          <Empty icon={<KeyRound />} title={all ? "Nobody has an API key yet" : "You have no API keys yet"}>
            <p>Create one for each tool that uses Shorthop, so you can revoke them one by one.</p>
          </Empty>
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line">
            {list.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-3 px-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-fg">
                    {k.name}
                    <code className="font-mono text-xs font-normal text-muted">shp_{k.id}_…</code>
                    {k.expired ? <Badge tone="danger">Expired</Badge> : null}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    {all ? `${k.owner} · ` : ""}
                    {keySummary(k.permissions)}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    Created {date(k.createdAt)} ·{" "}
                    <span title={k.lastUsedAt ? whenFull(k.lastUsedAt) : undefined}>{k.lastUsedAt ? `last used ${ago(k.lastUsedAt)}` : "never used"}</span>
                    {k.expiresAt && !k.expired ? ` · expires ${date(k.expiresAt)}` : ""}
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setRevoking(k)}>
                  <Trash2 /> Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

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
      <Dialog open={created !== null} onOpenChange={(o) => !o && setCreated(null)} title={`Your key “${created?.key.name}”`} description="Copy it now: it's shown only once. Store it where the tool keeps secrets." wide>
        {created ? <NewKey created={created} origin={origin} onDone={() => setCreated(null)} /> : null}
      </Dialog>
      <Dialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revoke “${revoking?.name}”?`}
        description="Anything using this key stops working right away. This can't be undone; create a new key if you need one again."
      >
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setRevoking(null)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => revoking && revoke.mutate(revoking)} loading={revoke.isPending}>
            Revoke
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}

function CreateKeyDialog({ me, onClose, onCreated }: { me: MeDTO; onClose: () => void; onCreated: (k: NewApiKeyDTO) => void }) {
  const qc = useQueryClient();
  // Keys can't manage keys, so "Personal API keys" isn't offered.
  const offered = me.permissions.filter((p) => p !== "api.use");
  const [name, setName] = useState("");
  const [perms, setPerms] = useState<Permission[]>(offered.includes("links.create") ? ["links.create"] : []);
  const [expiry, setExpiry] = useState<Expiry>("never");

  const create = useMutation({
    mutationFn: () =>
      call(api.keys.$post({ json: { name, permissions: perms, expiresInDays: expiry === "never" ? null : (Number(expiry) as 30 | 90 | 365) } })),
    onSuccess: (k) => {
      void qc.invalidateQueries({ queryKey: ["api-keys"] });
      void qc.invalidateQueries({ queryKey: keys.people });
      onCreated(k);
    },
    onError: (e) => toast.error(e.message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Create an API key" wide>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name" htmlFor="key-name" hint="What uses it, such as “iOS Shortcut” or “Zapier”.">
          <Input id="key-name" required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <fieldset className="space-y-2">
          <legend className="mb-1.5 text-sm font-medium text-fg">What it may do</legend>
          <p className="text-xs text-muted">Every key can list links and read their details. Tick only what the tool needs.</p>
          {offered.length ? (
            <ul className="divide-y divide-line rounded-md border border-line">
              {offered.map((p) => (
                <li key={p}>
                  <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5">
                    <input
                      type="checkbox"
                      className="mt-1 accent-[var(--accent)]"
                      checked={perms.includes(p)}
                      onChange={(e) => setPerms((list) => (e.target.checked ? [...list, p] : list.filter((x) => x !== p)))}
                    />
                    <span>
                      <span className="block text-sm font-medium text-fg">{PERMISSION_INFO[p].label}</span>
                      <span className="block text-xs text-muted">{PERMISSION_INFO[p].description}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          ) : null}
        </fieldset>
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-fg">Stops working after</p>
          <Segmented label="Stops working after" value={expiry} onChange={setExpiry} options={EXPIRY} />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={create.isPending} disabled={!name.trim()}>
            Create key
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function NewKey({ created, origin, onDone }: { created: NewApiKeyDTO; origin: string; onDone: () => void }) {
  const canCreate = created.key.permissions.includes("links.create");
  const example = canCreate
    ? `curl -X POST "${origin}/api/links?format=text" \\
  -H "Authorization: Bearer ${created.secret}" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://example.com/new-post"}'`
    : `curl "${origin}/api/links" \\
  -H "Authorization: Bearer ${created.secret}"`;
  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-center gap-2 rounded-md border border-line bg-bg p-3">
        <code className="min-w-0 flex-1 font-mono text-xs break-all text-fg">{created.secret}</code>
        <Button variant="outline" size="sm" onClick={() => void copy(created.secret, "API key copied")}>
          <Copy /> Copy
        </Button>
      </div>
      <p className="text-muted">
        Send it as the header <code className="font-mono text-xs text-fg">Authorization: Bearer {"<key>"}</code>. In a tool such as Zapier, Make or n8n, use an HTTP request step with that header and the base URL{" "}
        <code className="font-mono text-xs text-fg">{origin}/api</code>.
      </p>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="font-medium text-fg">{canCreate ? "Create a link from a terminal" : "List your links from a terminal"}</p>
          <Button variant="ghost" size="sm" onClick={() => void copy(example, "Command copied")}>
            <Copy /> Copy
          </Button>
        </div>
        <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-xs text-fg">{example}</pre>
      </div>
      <div className="flex justify-end">
        <Button onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}
