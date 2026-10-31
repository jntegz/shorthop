// The bar for the ticked links: POST /links/bulk in plan-sized parts, with
// confirmations for the risky actions, progress and a summary toast.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, Ellipsis, Power, QrCode, Share2, Tag, Trash2, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { BulkAction, BulkResult, LinkListItem } from "../../../shared/types";
import { api, call, downloadFile, keys } from "../../api";
import { num } from "../../lib/format";
import { useCan, useMe } from "../../lib/me";
import { Button, Dialog, errorText, IconButton, Input, Menu, type MenuItem } from "../ui";

async function runBulk(links: LinkListItem[], action: BulkAction, tag: string | undefined, part: number, onProgress: (done: number) => void): Promise<BulkResult> {
  const total: BulkResult = { changed: 0, unchanged: 0, failed: [] };
  for (let i = 0; i < links.length; i += part) {
    const chunk = links.slice(i, i + part).map(({ domain, slug }) => ({ domain, slug }));
    const r = await call(api.links.bulk.$post({ json: { links: chunk, action, ...(tag ? { tag } : {}) } }));
    total.changed += r.changed;
    total.unchanged += r.unchanged;
    total.failed.push(...r.failed);
    onProgress(Math.min(links.length, i + part));
  }
  return total;
}

const DONE: Record<BulkAction, string> = {
  enable: "enabled",
  disable: "disabled",
  addTag: "tagged",
  removeTag: "untagged",
  delete: "deleted",
};

const plural = (n: number) => `${num(n)} ${n === 1 ? "link" : "links"}`;

export function BulkBar({ selected, tags, onClear, onQr, onShare }: { selected: LinkListItem[]; tags: string[]; onClear: () => void; onQr: () => void; onShare?: () => void }) {
  const qc = useQueryClient();
  const can = useCan();
  const part = useMe().data?.workspace.bulkRows ?? 20;
  const [tagging, setTagging] = useState<"addTag" | "removeTag" | null>(null);
  const [tag, setTag] = useState("");
  const [confirm, setConfirm] = useState<"delete" | "disable" | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const n = selected.length;

  const run = useMutation({
    mutationFn: ({ action, tag }: { action: BulkAction; tag?: string }) => {
      setProgress(0);
      return runBulk(selected, action, tag, part, setProgress);
    },
    onSuccess: (r, { action }) => {
      const failed = r.failed.length ? ` ${r.failed.length} failed: ${r.failed.slice(0, 3).map((f) => `${f.slug} (${f.error})`).join(", ")}${r.failed.length > 3 ? "…" : ""}` : "";
      const msg = `${plural(r.changed)} ${DONE[action]}${r.unchanged ? ` · ${num(r.unchanged)} already were` : ""}.`;
      if (r.failed.length) toast.warning(msg, { description: failed, duration: 15_000 });
      else toast.success(msg, action === "delete" ? { description: "You can bring them back from Recently deleted for 90 days." } : undefined);
      setConfirm(null);
      setTagging(null);
      setTag("");
      if (action === "delete") onClear();
    },
    onError: (e) => toast.error(`Stopped partway: ${errorText(e) ?? "unknown error"}`),
    onSettled: () => {
      setProgress(null);
      void qc.invalidateQueries({ queryKey: keys.allLinks });
      void qc.invalidateQueries({ queryKey: keys.tags });
      void qc.invalidateQueries({ queryKey: keys.deleted });
    },
  });

  if (!n) return null;
  const busy = run.isPending;
  const edits = can("links.edit");
  const deletes = can("links.delete");
  const exportSelection = () => {
    setExporting(true);
    downloadFile(`/_admin/api/export/links.csv?links=${encodeURIComponent(selected.map((l) => `${l.domain}/${l.slug}`).join(","))}`)
      .catch((e: unknown) => toast.error(errorText(e) ?? "The export failed."))
      .finally(() => setExporting(false));
  };

  const enable: MenuItem = { label: "Enable", icon: Power, disabled: busy, onSelect: () => run.mutate({ action: "enable" }) };
  const disable: MenuItem = { label: "Disable…", icon: Power, disabled: busy, onSelect: () => setConfirm("disable") };
  const addTag: MenuItem = { label: "Add tag…", icon: Tag, disabled: busy, onSelect: () => setTagging("addTag") };
  const removeTag: MenuItem = { label: "Remove tag…", icon: Tag, disabled: busy, onSelect: () => setTagging("removeTag") };
  const share: MenuItem | null = onShare ? { label: "Share report…", icon: Share2, disabled: busy, onSelect: onShare } : null;
  const del: MenuItem = { label: "Delete…", icon: Trash2, danger: true, disabled: busy, onSelect: () => setConfirm("delete") };
  const qr: MenuItem = { label: "QR codes", icon: QrCode, disabled: busy, onSelect: onQr };
  const exp: MenuItem = { label: "Export CSV", icon: Download, disabled: busy || exporting, onSelect: exportSelection };

  // Wide screens: the frequent actions as buttons, the rest in More. Phones: one menu.
  const more: (MenuItem | "separator")[] = [...(edits ? [enable, disable, removeTag] : []), ...(share ? [share] : [])];
  const all: (MenuItem | "separator")[] = [...(edits ? [addTag, removeTag, enable, disable] : []), exp, qr, ...(share ? [share] : []), ...(deletes ? ["separator" as const, del] : [])];

  return (
    <div className="links-bulk" role="region" aria-label="Selected links">
      <span className="links-bulk-count" aria-live="polite">
        {progress !== null ? `Working… ${num(progress)} of ${num(n)}` : `${num(n)} selected`}
      </span>
      <div className="links-bulk-wide">
        {edits ? <Button size="sm" variant="ghost" icon={Tag} disabled={busy} onClick={() => setTagging("addTag")}>Add tag</Button> : null}
        <Button size="sm" variant="ghost" icon={Download} loading={exporting} disabled={busy} onClick={exportSelection}>Export</Button>
        <Button size="sm" variant="ghost" icon={QrCode} disabled={busy} onClick={onQr}>QR codes</Button>
        {more.length ? <Menu label="More actions for the selected links" items={more} trigger={<Button size="sm" variant="ghost" icon={Ellipsis} disabled={busy}>More</Button>} /> : null}
        {deletes ? <Button size="sm" variant="ghost" icon={Trash2} className="links-bulk-delete" disabled={busy} onClick={() => setConfirm("delete")}>Delete</Button> : null}
      </div>
      <div className="links-bulk-narrow">
        <Menu label="Actions for the selected links" items={all} trigger={<Button size="sm" icon={Ellipsis} disabled={busy}>Actions</Button>} />
      </div>
      <IconButton label="Clear selection (Esc)" icon={X} size="sm" className="links-bulk-clear" onClick={onClear} disabled={busy} />

      <Dialog
        open={confirm !== null}
        onOpenChange={(o) => !o && !busy && setConfirm(null)}
        size="sm"
        title={confirm === "delete" ? `Delete ${plural(n)}?` : `Disable ${plural(n)}?`}
        description={
          confirm === "delete"
            ? "They stop working and their slugs become free. Their shared statistics pages end. You can restore them from Recently deleted for 90 days."
            : `Visitors go where each link’s “turned off” setting sends them (the not-found page unless set). Each link is republished: ${num(n)} KV ${n === 1 ? "write" : "writes"}, out of 1,000 a day on Workers Free.`
        }
        footer={
          <>
            <Button onClick={() => setConfirm(null)} disabled={busy}>Cancel</Button>
            <Button variant={confirm === "delete" ? "danger" : "primary"} loading={busy} onClick={() => confirm && run.mutate({ action: confirm })}>
              {confirm === "delete" ? `Delete ${num(n)}` : `Disable ${num(n)}`}
            </Button>
          </>
        }
      />
      <Dialog
        open={tagging !== null}
        onOpenChange={(o) => !o && !busy && setTagging(null)}
        size="sm"
        title={tagging === "addTag" ? `Add a tag to ${plural(n)}` : `Remove a tag from ${plural(n)}`}
      >
        <form
          className="links-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (tagging && tag.trim()) run.mutate({ action: tagging, tag: tag.trim() });
          }}
        >
          <Input label="Tag" hint="Lowercase; spaces become dashes." autoFocus maxLength={40} value={tag} onChange={(e) => setTag(e.target.value)} placeholder="launch-week" list="links-bulk-tags" autoComplete="off" spellCheck={false} />
          <datalist id="links-bulk-tags">
            {tags.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          <div className="links-form-foot">
            <Button onClick={() => setTagging(null)} disabled={busy}>Cancel</Button>
            <Button type="submit" variant="primary" loading={busy} disabled={!tag.trim()}>
              {tagging === "addTag" ? "Add tag" : "Remove tag"}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
