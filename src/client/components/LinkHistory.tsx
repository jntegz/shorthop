import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Flag, History, Pencil, Plus, RotateCcw, Trash2, Upload, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { splitKey } from "../../shared/domains";
import { BOOLEAN_FIELDS, diffSnapshots, FIELD_LABEL, type FieldChange, type HistoryAction, type HistoryField, type Snapshot } from "../../shared/history";
import { parsePreview } from "../../shared/preview";
import { describeRouting, parseRouting } from "../../shared/routing";
import type { LinkDTO, VersionDTO } from "../../shared/types";
import { api, call, keys } from "../api";
import { useCan } from "../lib/me";
import { ago, whenFull } from "../lib/format";
import { useLinkLabel } from "../lib/links";
import { cn } from "../lib/utils";
import { Badge, Button, Card, CardHeader, Dialog, Empty, Notice, Spinner } from "./ui";

/** Versions shown before "Show all". */
const COLLAPSED = 5;

const ACTION: Record<HistoryAction, { icon: LucideIcon; label: string; tone: string }> = {
  create: { icon: Plus, label: "Created", tone: "bg-good-soft text-good" },
  update: { icon: Pencil, label: "Edited", tone: "bg-accent-soft text-accent" },
  import: { icon: Upload, label: "Imported", tone: "bg-accent-soft text-accent" },
  restore: { icon: RotateCcw, label: "Restored", tone: "bg-warn-soft text-warn" },
  delete: { icon: Trash2, label: "Deleted", tone: "bg-danger-soft text-danger" },
  baseline: { icon: Flag, label: "History started", tone: "bg-surface-2 text-muted" },
};

/** The current link as a snapshot, to compare versions with. */
export function snapshotOfLink(l: LinkDTO): Snapshot {
  return {
    target: l.target,
    active: l.active ? 1 : 0,
    expires_at: l.expiresAt,
    utm: l.utm ? 1 : 0,
    utm_template: l.utmTemplate,
    pass_query: l.passQuery ? 1 : 0,
    title: l.title,
    tags: l.tags.join(","),
    notes: l.notes,
    broken: l.broken ? 1 : 0,
    replacement: l.replacement ? `${l.replacement.domain}/${l.replacement.slug}` : null,
    monitor: l.monitor ? 1 : 0,
    routing: l.routing ? JSON.stringify(l.routing) : null,
    preview: l.preview ? JSON.stringify(l.preview) : null,
    // Only the history's fingerprints are comparable; "set" vs null is enough here.
    password_hash: l.protected ? "set" : null,
    max_clicks: l.maxClicks,
  };
}

export function actorName(actor: string): string {
  if (actor === "api-token") return "API token";
  if (actor === "system") return "Shorthop";
  return actor;
}

function Value({ field, value, old }: { field: HistoryField; value: Snapshot[HistoryField] | null; old?: boolean }) {
  const label = useLinkLabel();
  const cls = cn("min-w-0 rounded px-1.5 py-0.5 text-xs break-words", old ? "bg-danger-soft/70 text-muted line-through decoration-danger/40" : "bg-good-soft text-fg");
  if (BOOLEAN_FIELDS.has(field)) return <span className={cls}>{value ? "On" : "Off"}</span>;
  if (value === null || value === "") {
    const none = field === "expires_at" ? "Never" : field === "routing" || field === "preview" ? "Off" : field === "password_hash" ? "None" : field === "max_clicks" ? "No limit" : field === "replacement" ? "None" : field === "utm_template" ? "Default" : "Empty";
    return <span className={cn(cls, "italic")}>{none}</span>;
  }
  if (field === "password_hash") return <span className={cls}>{value ? "Set" : "None"}</span>;
  if (field === "max_clicks") return <span className={cls}>{value ? `${Number(value).toLocaleString("en")} visits` : "No limit"}</span>;
  if (field === "preview") {
    const p = parsePreview(String(value));
    return <span className={cls}>{p ? `“${p.title}”${p.image ? " with image" : ""}` : "Off"}</span>;
  }
  if (field === "routing") return <span className={cls}>{describeRouting(parseRouting(String(value)))}</span>;
  if (field === "expires_at") return <span className={cls}>{whenFull(Number(value))}</span>;
  if (field === "replacement") {
    const r = splitKey(String(value));
    return <span className={cls}>{r ? label(r) : String(value)}</span>;
  }
  const text = String(value);
  return (
    <span className={cn(cls, field === "notes" ? "line-clamp-3 whitespace-pre-wrap" : "line-clamp-2", (field === "target" || field === "utm_template") && "font-mono text-[11px]")} title={text}>
      {text}
    </span>
  );
}

/** Tags read best as what was added and what was removed. */
function TagChange({ before, after }: { before: string; after: string }) {
  const b = new Set(before ? before.split(",") : []);
  const a = new Set(after ? after.split(",") : []);
  const added = [...a].filter((t) => !b.has(t));
  const removed = [...b].filter((t) => !a.has(t));
  return (
    <span className="flex flex-wrap gap-1">
      {added.map((t) => (
        <Badge key={`+${t}`} tone="good">
          + {t}
        </Badge>
      ))}
      {removed.map((t) => (
        <Badge key={`-${t}`} tone="danger" className="line-through decoration-danger/40">
          {t}
        </Badge>
      ))}
    </span>
  );
}

export function ChangeList({ changes }: { changes: FieldChange[] }) {
  return (
    <dl className="mt-2 space-y-1.5">
      {changes.map((c) => (
        <div key={c.field} className="grid gap-1 text-xs sm:grid-cols-[9.5rem_1fr]">
          <dt className="pt-0.5 text-muted">{FIELD_LABEL[c.field]}</dt>
          <dd className="flex min-w-0 flex-wrap items-center gap-1.5">
            {c.field === "password_hash" && c.before && c.after ? (
              <span className="rounded bg-good-soft px-1.5 py-0.5 text-xs text-fg">Changed to a new password</span>
            ) : c.field === "tags" ? (
              <TagChange before={String(c.before ?? "")} after={String(c.after ?? "")} />
            ) : (
              <>
                <Value field={c.field} value={c.before} old />
                <ArrowRight className="size-3 shrink-0 text-subtle" aria-label="changed to" />
                <Value field={c.field} value={c.after} />
              </>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function RestoreDialog({ link, current, version, onClose }: { link: LinkDTO; current: Snapshot; version: VersionDTO; onClose: () => void }) {
  const qc = useQueryClient();
  const changes = diffSnapshots(current, version.snapshot);
  const restore = useMutation({
    mutationFn: () =>
      call(api.links[":domain"][":slug"].history[":id"].restore.$post({ param: { domain: link.domain, slug: link.slug, id: String(version.id) } })),
    onSuccess: (data) => {
      qc.setQueryData(keys.link(link.domain, link.slug), data);
      void qc.invalidateQueries({ queryKey: keys.allLinks });
      void qc.invalidateQueries({ queryKey: keys.linkHistory(link.domain, link.slug) });
      void qc.invalidateQueries({ queryKey: keys.checks });
      toast.success("Version restored", { description: "Live worldwide within about a minute. The previous state stays in the history." });
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Restore the version from ${whenFull(version.at)}?`} description="These settings change back. Stats aren't affected, and the current state stays in the history so you can undo this." wide>
      {changes.length ? (
        <div className="rounded-xl border border-line bg-bg px-4 py-3">
          <p className="text-xs font-medium text-fg">What changes</p>
          <ChangeList changes={changes} />
        </div>
      ) : (
        <Notice tone="accent">The link already matches this version.</Notice>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => restore.mutate()} loading={restore.isPending} disabled={!changes.length}>
          <RotateCcw /> Restore this version
        </Button>
      </div>
    </Dialog>
  );
}

/** Link page → History: every saved state, what changed in each, and a way back. */
export function LinkHistory({ link }: { link: LinkDTO }) {
  const edits = useCan()("links.edit");
  const [all, setAll] = useState(false);
  const [restoring, setRestoring] = useState<VersionDTO | null>(null);
  const q = useQuery({
    queryKey: [...keys.linkHistory(link.domain, link.slug), link.updatedAt],
    queryFn: () => call(api.links[":domain"][":slug"].history.$get({ param: { domain: link.domain, slug: link.slug } })),
  });
  const versions = q.data?.versions ?? [];
  // The admin never sees password hashes; the newest version's fingerprint stands for the current one.
  const current: Snapshot = { ...snapshotOfLink(link), password_hash: link.protected ? (versions[0]?.snapshot.password_hash ?? "set") : null };
  const shown = all ? versions : versions.slice(0, COLLAPSED);

  return (
    <Card id="history" className="mt-4 scroll-mt-6">
      <CardHeader
        title="History"
        description="Every change to this link, newest first. Restore any earlier version; stats are never affected."
      />
      {q.isPending ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : q.isError ? (
        <p className="px-5 pb-5 text-sm text-danger">{q.error.message}</p>
      ) : versions.length === 0 ? (
        <Empty icon={<History />} title="No history yet">
          <p>Changes are recorded from now on.</p>
        </Empty>
      ) : (
        <>
          <ol className="relative px-5 pb-2">
            {shown.map((v, i) => {
              const older = versions[versions.indexOf(v) + 1];
              const changes = v.action === "delete" || !older || older.action === "delete" ? [] : diffSnapshots(older.snapshot, v.snapshot);
              const { icon: Icon, label, tone } = ACTION[v.action];
              const isCurrent = v === versions[0] && v.action !== "delete";
              const restorable = v.action !== "delete" && diffSnapshots(current, v.snapshot).length > 0;
              const restoredFrom = v.restoredFrom ? versions.find((x) => x.id === v.restoredFrom) : null;
              return (
                <li key={v.id} className="relative flex gap-3 pb-5 last:pb-3">
                  {i < shown.length - 1 ? <span className="absolute top-8 bottom-0 left-[15px] w-px bg-line" aria-hidden /> : null}
                  <span className={cn("relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full ring-4 ring-surface", tone)}>
                    <Icon className="size-3.5" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1 pt-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <p className="text-sm font-medium text-fg">
                        {label}
                        {v.action === "restore" && restoredFrom ? <span className="font-normal text-muted"> the version from {whenFull(restoredFrom.at)}</span> : null}
                      </p>
                      {isCurrent ? <Badge tone="good">Current</Badge> : null}
                      <span className="text-xs text-muted" title={whenFull(v.at)}>
                        {ago(v.at)} · {actorName(v.actor)}
                      </span>
                      {restorable && edits ? (
                        <Button variant="ghost" size="sm" className="ml-auto h-7 px-2 text-xs" onClick={() => setRestoring(v)}>
                          <RotateCcw /> Restore
                        </Button>
                      ) : null}
                    </div>
                    {changes.length ? (
                      <ChangeList changes={changes} />
                    ) : v.action === "create" || v.action === "import" || v.action === "baseline" ? (
                      <p className="mt-1 truncate text-xs text-muted" title={v.snapshot.target}>
                        {v.action === "baseline" ? "As it was when history began: " : "Pointing to "}
                        <span className="font-mono text-[11px]">{v.snapshot.target}</span>
                      </p>
                    ) : v.action === "delete" ? (
                      <p className="mt-1 text-xs text-muted">The link was removed; it was brought back later.</p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
          {versions.length > COLLAPSED ? (
            <div className="border-t border-line px-5 py-3">
              <button type="button" className="text-xs font-medium text-accent hover:underline" onClick={() => setAll(!all)} aria-expanded={all}>
                {all ? "Show fewer" : `Show all ${versions.length} versions`}
              </button>
            </div>
          ) : null}
        </>
      )}
      {restoring ? <RestoreDialog link={link} current={current} version={restoring} onClose={() => setRestoring(null)} /> : null}
    </Card>
  );
}
