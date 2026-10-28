import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Lock, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { linkPasswordProblem } from "../../shared/protection";
import type { LinkDTO, ShareDTO, ShareRange } from "../../shared/types";
import { api, call } from "../api";
import { ago, fromLocalInput, num, toLocalInput, when } from "../lib/format";
import { copy } from "../lib/utils";
import { Badge, Button, Dialog, Field, Input, Select, Spinner } from "./ui";

const sharesKey = (domain: string, slug: string) => ["link", domain, slug, "shares"] as const;

export function useShares(domain: string, slug: string, enabled: boolean) {
  return useQuery({
    queryKey: sharesKey(domain, slug),
    queryFn: () => call(api.links[":domain"][":slug"].shares.$get({ param: { domain, slug } })),
    enabled,
  });
}

const RANGE_OPTIONS: { value: ShareRange | ""; label: string }[] = [
  { value: "", label: "Any period, up to all time" },
  { value: "7d", label: "Up to the last 7 days" },
  { value: "30d", label: "Up to the last 30 days" },
  { value: "90d", label: "Up to the last 90 days" },
  { value: "365d", label: "Up to the last 12 months" },
];

const STATUS_TONE = { active: "good", expired: "warn", revoked: "neutral" } as const;

/** A week from now, on the hour: a sensible first end date. */
function defaultExpiry(): string {
  const d = new Date(Date.now() + 7 * 86400_000);
  d.setMinutes(0, 0, 0);
  return toLocalInput(Math.floor(d.getTime() / 1000));
}

/** Link page → Share: read-only statistics pages for people without an account. */
export function ShareStats({ link, label, open, onOpenChange }: { link: LinkDTO; label: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { domain, slug } = link;
  const qc = useQueryClient();
  const shares = useShares(domain, slug, true);
  const [expires, setExpires] = useState(true);
  const [expiresAt, setExpiresAt] = useState(defaultExpiry);
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState("");
  const [rangeLimit, setRangeLimit] = useState<ShareRange | "">("");
  const [showRecent, setShowRecent] = useState(false);

  const expirySec = expires ? fromLocalInput(expiresAt) : null;
  const expiryProblem = expires && (!expirySec || expirySec * 1000 <= Date.now()) ? "Pick a date and time in the future." : null;
  const passwordProblem = usePassword ? linkPasswordProblem(password) : null;

  const refresh = () => void qc.invalidateQueries({ queryKey: sharesKey(domain, slug) });
  const create = useMutation({
    mutationFn: () =>
      call(
        api.links[":domain"][":slug"].shares.$post({
          param: { domain, slug },
          json: { expiresAt: expirySec, password: usePassword ? password : null, rangeLimit: rangeLimit || null, showRecent },
        }),
      ),
    onSuccess: async ({ share }) => {
      refresh();
      setPassword("");
      if (share.url) await copy(share.url);
      toast.success("Share link created", { description: share.url ? "The address is copied. Send it with the password, if you set one." : undefined });
    },
    onError: (e) => toast.error(e.message),
  });
  const update = useMutation({
    mutationFn: ({ id, json }: { id: string; json: { revoke?: true; expiresAt?: number | null } }) => call(api.shares[":id"].$patch({ param: { id }, json })),
    onSuccess: (_data, { json }) => {
      refresh();
      toast.success(json.revoke ? "Share revoked: the address stops working now" : "Share updated");
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => call(api.shares[":id"].$delete({ param: { id } })),
    onSuccess: () => refresh(),
    onError: (e) => toast.error(e.message),
  });

  const list = shares.data?.shares ?? [];
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      wide
      title={`Share statistics for ${label}`}
      description="Anyone with the address sees this link's clicks, countries, sources and devices, read-only. They don't see its destination, history or revenue, and can't change anything."
    >
      <div className="space-y-4">
        <div className="space-y-3 rounded-lg border border-line p-4">
          <label className="flex items-center gap-2 text-sm text-fg">
            <input type="checkbox" checked={expires} onChange={(e) => setExpires(e.target.checked)} />
            Stop sharing automatically
          </label>
          {expires ? (
            <Field label="Shared until" htmlFor="share-expiry" error={expiryProblem} hint="Your local time. After this, the address shows “no longer shared”.">
              <Input id="share-expiry" type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
            </Field>
          ) : null}
          <label className="flex items-center gap-2 text-sm text-fg">
            <input type="checkbox" checked={usePassword} onChange={(e) => setUsePassword(e.target.checked)} />
            Require a password
          </label>
          {usePassword ? (
            <Field label="Password" htmlFor="share-password" error={password ? passwordProblem : null} hint="Send it separately from the address. It's stored hashed and can't be shown again.">
              <Input id="share-password" type="text" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
          ) : null}
          <Field label="Periods viewers can pick" htmlFor="share-range">
            <Select id="share-range" value={rangeLimit} onChange={(e) => setRangeLimit(e.target.value as ShareRange | "")}>
              {RANGE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <label className="flex items-start gap-2 text-sm text-fg">
            <input type="checkbox" className="mt-1" checked={showRecent} onChange={(e) => setShowRecent(e.target.checked)} />
            <span>
              Show recent clicks
              <span className="block text-xs text-muted">The last 20 clicks with time, city, device and source. No visitor ids.</span>
            </span>
          </label>
          <div className="flex justify-end">
            <Button onClick={() => create.mutate()} loading={create.isPending} disabled={Boolean(expiryProblem || passwordProblem)}>
              Create and copy link
            </Button>
          </div>
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold text-fg">Shares of this link</h3>
          {shares.isPending ? (
            <Spinner />
          ) : list.length === 0 ? (
            <p className="text-sm text-muted">Not shared yet.</p>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {list.map((s) => (
                <ShareItem
                  key={s.id}
                  share={s}
                  busy={update.isPending || remove.isPending}
                  onRevoke={() => update.mutate({ id: s.id, json: { revoke: true } })}
                  onExpiry={(sec) => update.mutate({ id: s.id, json: { expiresAt: sec } })}
                  onDelete={() => remove.mutate(s.id)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function ShareItem({
  share: s,
  busy,
  onRevoke,
  onExpiry,
  onDelete,
}: {
  share: ShareDTO;
  busy: boolean;
  onRevoke: () => void;
  onExpiry: (sec: number | null) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(toLocalInput(s.expiresAt));
  const active = s.status === "active";
  return (
    <li className="space-y-2 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[s.status]}>{s.status === "active" ? "Active" : s.status === "expired" ? "Expired" : "Revoked"}</Badge>
        {s.protected ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted">
            <Lock className="size-3" aria-hidden /> Password
          </span>
        ) : null}
        <span className="text-xs text-muted">
          {s.expiresAt ? `${active ? "Until" : "Ended"} ${when(s.expiresAt)}` : s.revokedAt ? `Revoked ${ago(s.revokedAt)}` : "Until revoked"}
          {" · "}
          {num(s.views)} {s.views === 1 ? "view" : "views"}
          {s.lastViewedAt ? `, last ${ago(s.lastViewedAt)}` : ""}
        </span>
        <span className="ml-auto text-xs text-subtle">Created {ago(s.createdAt)}</span>
      </div>
      {active && s.url ? (
        <div className="flex gap-2">
          <Input readOnly value={s.url} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} aria-label="Share address" />
          <Button variant="outline" size="sm" onClick={() => void copy(s.url!)}>
            <Copy /> Copy
          </Button>
        </div>
      ) : null}
      {active && editing ? (
        <div className="flex flex-wrap items-end gap-2">
          <Input type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} className="w-auto" aria-label="Shared until" />
          <Button size="sm" disabled={busy} onClick={() => { onExpiry(fromLocalInput(value)); setEditing(false); }}>
            Save
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { onExpiry(null); setEditing(false); }}>
            No end date
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {active ? (
          <>
            <Button variant="ghost" size="sm" onClick={() => setEditing((v) => !v)}>
              Change end date
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={onRevoke}>
              Stop sharing now
            </Button>
          </>
        ) : (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onDelete}>
            <Trash2 /> Remove from list
          </Button>
        )}
      </div>
    </li>
  );
}
