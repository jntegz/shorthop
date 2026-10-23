import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArchiveRestore, RotateCcw } from "lucide-react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { DELETED_RETENTION_DAYS } from "../../shared/history";
import { api, call, keys } from "../api";
import { ago, hostOf, whenFull } from "../lib/format";
import { linkKey, linkPath, useLinkLabel } from "../lib/links";
import { actorName } from "./LinkHistory";
import { Button, Dialog, Empty, Notice, Spinner } from "./ui";

/** Brings back a deleted link; shared by the dialog and the "Undo" after a delete. */
export function useRestoreDeleted() {
  const qc = useQueryClient();
  const label = useLinkLabel();
  return useMutation({
    mutationFn: (l: { domain: string; slug: string }) => call(api.deleted[":domain"][":slug"].restore.$post({ param: l })),
    onSuccess: ({ link }) => {
      qc.setQueryData(keys.link(link.domain, link.slug), { link });
      void qc.invalidateQueries({ queryKey: keys.allLinks });
      void qc.invalidateQueries({ queryKey: keys.deleted });
      void qc.invalidateQueries({ queryKey: keys.checks });
      toast.success(`${label(link)} restored`, { description: "Live again worldwide within about a minute, with its stats." });
    },
    onError: (e) => toast.error(e.message),
  });
}

/** Links → Recently deleted. */
export function DeletedLinks({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const label = useLinkLabel();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: keys.deleted, queryFn: () => call(api.deleted.$get()), enabled: open });
  const restore = useRestoreDeleted();
  const links = q.data?.links ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Recently deleted"
      description={`Deleted links can be brought back for ${DELETED_RETENTION_DAYS} days, with their slug, settings and stats, as long as no new link has taken the slug.`}
      wide
    >
      {q.isPending ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : q.isError ? (
        <Notice tone="danger">{q.error.message}</Notice>
      ) : links.length === 0 ? (
        <Empty icon={<ArchiveRestore />} title="Nothing deleted recently">
          <p>Links you delete show up here for {DELETED_RETENTION_DAYS} days.</p>
        </Empty>
      ) : (
        <ul className="-mx-2 divide-y divide-line">
          {links.map((l) => {
            const busy = restore.isPending && restore.variables?.domain === l.domain && restore.variables.slug === l.slug;
            return (
              <li key={linkKey(l.domain, l.slug)} className="flex flex-wrap items-center gap-3 px-2 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-fg">
                    {label(l)}
                    {l.title ? <span className="ml-2 font-normal text-muted">{l.title}</span> : null}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted" title={l.target}>
                    {hostOf(l.target)} · deleted <span title={whenFull(l.deletedAt)}>{ago(l.deletedAt)}</span> by {actorName(l.actor)}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  loading={busy}
                  disabled={restore.isPending && !busy}
                  onClick={() =>
                    restore.mutate(l, {
                      onSuccess: ({ link }) => {
                        onOpenChange(false);
                        navigate(linkPath(link));
                      },
                    })
                  }
                >
                  {busy ? null : <RotateCcw />} Restore
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
