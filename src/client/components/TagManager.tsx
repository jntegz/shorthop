import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api, call, keys } from "../api";
import { num } from "../lib/format";
import { Button, ConfirmDialog, Dialog, Empty, errorMessage, Input, LoadError, Spinner } from "./ui";

/** Rename (or merge) and remove tags across every link. */
export function TagManager({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const tags = useQuery({ queryKey: keys.tags, queryFn: () => call(api.tags.$get()), enabled: open });
  const [renaming, setRenaming] = useState<string | null>(null);
  const [to, setTo] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.tags });
    void qc.invalidateQueries({ queryKey: keys.allLinks });
  };
  const rename = useMutation({
    mutationFn: (v: { from: string; to: string }) => call(api.tags.rename.$post({ json: v })),
    onSuccess: (r, v) => {
      toast.success(`Renamed “${v.from}” on ${num(r.changed)} ${r.changed === 1 ? "link" : "links"}`);
      setRenaming(null);
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (tag: string) => call(api.tags[":tag"].$delete({ param: { tag } })),
    onSuccess: (r, tag) => {
      toast.success(`Removed “${tag}” from ${num(r.changed)} ${r.changed === 1 ? "link" : "links"}`);
      setRemoving(null);
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const list = tags.data?.tags ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Tags" description="Renaming to a tag that already exists merges the two. Changes keep a version on each link.">
      {tags.isPending ? (
        <div className="flex justify-center py-8"><Spinner /></div>
      ) : tags.isError && !tags.data ? (
        <LoadError what="Tags" error={tags.error} onRetry={() => void tags.refetch()} retrying={tags.isFetching} />
      ) : !list.length ? (
        <Empty title="No tags yet">Add tags in a link's form, or to many links at once from the list.</Empty>
      ) : (
        <ul className="-mx-1 max-h-[60vh] divide-y divide-line overflow-y-auto">
          {list.map((t) => (
            <li key={t.tag} className="flex items-center gap-2 px-1 py-2">
              {renaming === t.tag ? (
                <form
                  className="flex flex-1 gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (to.trim()) rename.mutate({ from: t.tag, to: to.trim() });
                  }}
                >
                  <Input autoFocus aria-label={`New name for ${t.tag}`} maxLength={40} value={to} onChange={(e) => setTo(e.target.value)} className="h-9" />
                  <Button size="sm" type="submit" loading={rename.isPending} disabled={!to.trim()}>Rename</Button>
                  <Button size="sm" type="button" variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button>
                </form>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{t.tag}</span>
                  <span className="text-xs text-muted tabular">{num(t.count)} {t.count === 1 ? "link" : "links"}</span>
                  <Button size="icon-sm" variant="ghost" aria-label={`Rename ${t.tag}`} onClick={() => { setRenaming(t.tag); setTo(t.tag); }}><Pencil /></Button>
                  <Button size="icon-sm" variant="ghost" aria-label={`Remove ${t.tag}`} onClick={() => setRemoving(t.tag)}><Trash2 /></Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove “${removing ?? ""}” from every link?`}
        description="The links stay; only the tag is taken off them."
        confirmLabel="Remove tag"
        loading={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
      />
    </Dialog>
  );
}
